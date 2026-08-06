import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { resolveTask } from "./registerCommands";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { MergeOutcome } from "../git/mergeOutcome";
import { withStatus } from "../ui/statusProgress";

/**
 * Brings a branch — the task's base by default — into the task's worktree.
 *
 * The gap this closes: a worktree is a checkout of the base branch *as it was when
 * the task was created*, so tooling committed to the base afterwards is simply
 * absent. That surfaces as a stage failing, and a stage that fails because a verify
 * script is missing looks exactly like one that failed because the check found
 * something — so the fix ("merge the base in") is invisible from the symptom.
 *
 * Most of the value here is in what it refuses to do. Each refusal below is a way
 * this could quietly corrupt a task rather than fail it.
 */
export async function mergeIntoTaskCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  const blocker = await firstBlocker(ctx, task);
  if (blocker) {
    void vscode.window.showWarningMessage(blocker);
    return;
  }

  const branch = await chooseBranch(ctx, task);
  if (!branch) return;

  const outcome = await withStatus(`Merging "${branch}" into "${task.name}"`, () =>
    ctx.merges.mergeInto(task.worktreePath, branch),
  );

  if (!outcome.ok) {
    const detail =
      outcome.error.kind === "git"
        ? outcome.error.error.stderr.trim() || outcome.error.error.message
        : outcome.error.message;
    void vscode.window.showErrorMessage(`Could not merge "${branch}": ${detail}`);
    ctx.logger.error(`Harness [${task.name}] merge of "${branch}" failed: ${detail}`);
    return;
  }

  ctx.tree.refresh();
  report(ctx, task, branch, outcome.value);
}

/**
 * The first reason not to proceed, or undefined.
 *
 * Ordered cheapest-first, and returns one rather than all: these are conditions to
 * fix one at a time, and a wall of them reads as the feature being broken.
 */
async function firstBlocker(
  ctx: CommandContext,
  task: TaskWorkspace,
): Promise<string | undefined> {
  // The in-memory checks come first, so the common blocked cases cost no git at all.
  // Files changing under a running agent is its own class of bug: the session read
  // the tree at one revision and is still editing against what it remembers.
  const session = ctx.sessions.get(task.id);
  if (session && (session.status === "running" || session.status === "starting")) {
    return `"${task.name}" has an agent session running. Stop it before merging.`;
  }

  const active = task.pipeline?.stages.find((stage) => stage.status === "active");
  if (active) {
    return `"${task.name}" is running "${active.name}". Wait for it to settle before merging.`;
  }

  // The recorded intent against where the worktree actually is. When they disagree a
  // stage has moved the tree to a branch nobody asked about, and merging into that
  // branch would compound the problem rather than reveal it — which is the whole
  // reason `intendedBranch` is recorded separately from `branchName`.
  if (task.intendedBranch && task.intendedBranch !== task.branchName) {
    return (
      `"${task.name}" is on "${task.branchName}" but the task is about ` +
      `"${task.intendedBranch}". Check it out first, then merge.`
    );
  }

  // Only now the git call, which is the one expensive thing here.
  const live = await ctx.service.getLiveState(task);

  if (!live.worktreeExists) {
    return `"${task.name}" has no worktree on disk, so there is nothing to merge into.`;
  }

  // A merge over uncommitted work cannot be cleanly undone: `--abort` restores the
  // merge's changes, not the ones that were never committed. git would usually
  // refuse anyway, but refusing here says why in terms of the task.
  if (live.isDirty) {
    return (
      `"${task.name}" has ${live.changedFileCount} uncommitted change(s). ` +
      "Commit or stash them first — a merge over them could not be undone."
    );
  }

  return undefined;
}

/**
 * The branch to merge, defaulting to the task's base.
 *
 * A quick pick rather than a straight confirmation, because the default is right
 * most of the time and wrong in exactly the case that motivated this — a task based
 * on `main` needing something that landed on `dev`.
 */
async function chooseBranch(
  ctx: CommandContext,
  task: TaskWorkspace,
): Promise<string | undefined> {
  const listed = await ctx.merges.listBranches(task.repositoryRoot);
  const branches = listed.ok ? listed.value : [];
  if (!listed.ok) {
    // Not fatal: the base branch is recorded on the task, so the common case still
    // works without a list. Saying so beats a picker that silently has one entry.
    ctx.logger.warn(
      `Could not list branches in ${task.repositoryRoot}; offering the base branch only.`,
    );
  }

  type Item = vscode.QuickPickItem & { branch: string };
  const items: Item[] = [];

  if (task.baseBranch) {
    items.push({
      label: task.baseBranch,
      description: "base branch",
      detail: `Merge ${task.baseBranch} into ${task.branchName}`,
      branch: task.baseBranch,
    });
  }
  for (const branch of branches) {
    // Merging a branch into itself is a no-op git reports as up-to-date; leaving it
    // out is clearer than offering it and explaining the result.
    if (branch === task.baseBranch || branch === task.branchName) continue;
    items.push({ label: branch, branch });
  }

  if (items.length === 0) {
    void vscode.window.showWarningMessage(
      `No branch to merge into "${task.name}" — it has no recorded base branch.`,
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Merge into "${task.name}"`,
    placeHolder: task.baseBranch
      ? `${task.baseBranch} (base) — or pick another branch`
      : "Pick a branch to merge",
    ignoreFocusOut: true,
  });
  return picked?.branch;
}

function report(
  ctx: CommandContext,
  task: TaskWorkspace,
  branch: string,
  outcome: MergeOutcome,
): void {
  switch (outcome.kind) {
    case "up-to-date":
      ctx.logger.info(`Harness [${task.name}] already contains "${branch}".`);
      void vscode.window.showInformationMessage(
        `"${task.name}" already has everything from "${branch}".`,
      );
      return;

    case "merged":
      ctx.logger.info(
        `Harness [${task.name}] merged "${branch}"` +
          (outcome.fastForward ? " (fast-forward)." : "."),
      );
      void vscode.window.showInformationMessage(
        `Merged "${branch}" into "${task.name}". Re-run the stage that failed.`,
      );
      return;

    case "conflicted": {
      // The merge was aborted, so the worktree is as it was. Say that explicitly:
      // "conflicts" without it reads as the tree being left in pieces.
      const named = outcome.paths.slice(0, 5).join(", ");
      const more =
        outcome.paths.length > 5 ? ` and ${outcome.paths.length - 5} more` : "";
      ctx.logger.warn(
        `Harness [${task.name}] merge of "${branch}" conflicted and was undone: ` +
          (outcome.paths.join(", ") || "paths not reported"),
      );
      void vscode.window.showWarningMessage(
        `"${branch}" conflicts with "${task.name}" — the merge was undone, nothing changed. ` +
          (named ? `Conflicts in ${named}${more}.` : "") +
          " Merge it by hand in the worktree.",
      );
      return;
    }

    case "blocked": {
      // The paths are the actionable half — "commit or stash" without saying what is
      // in the way leaves the reader to go and find out.
      const named = outcome.paths.slice(0, 5).join(", ");
      const more =
        outcome.paths.length > 5 ? ` and ${outcome.paths.length - 5} more` : "";
      ctx.logger.warn(
        `Harness [${task.name}] merge refused: ${outcome.message} ` +
          (outcome.paths.join(", ") || "paths not reported"),
      );
      void vscode.window.showWarningMessage(
        outcome.message + (named ? ` In the way: ${named}${more}.` : ""),
      );
      return;
    }

    case "failed":
      ctx.logger.error(
        `Harness [${task.name}] merge of "${branch}" failed: ${outcome.message}`,
      );
      void vscode.window.showErrorMessage(
        `Could not merge "${branch}": ${outcome.message}`,
      );
      return;
  }
}

