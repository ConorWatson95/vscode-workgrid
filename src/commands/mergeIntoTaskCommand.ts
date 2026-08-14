import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { resolveTask } from "./registerCommands";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { MergeOutcome } from "../git/mergeOutcome";
import { withStatus } from "../ui/statusProgress";
import { describeDiscard } from "../domain/worktreeDiscard";

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

  // Before the tree is read, so the commit-or-stash question is asked about work rather
  // than about environment. Without this the command offered to commit a Web.config
  // transformed to run the solution against another tenant, and eight tracked build
  // artifacts a build had rewritten with the other line ending — nine files, none of
  // them work, and the two ways out were to commit them or to stash and restore them.
  //
  // Same call the runner makes before a stage's `verify`, and it announces itself the
  // same way: this is the one thing here that destroys work rather than reporting on
  // it, so it is never silent, and a staged change is never touched — staging one is
  // how a real Web.config edit is kept through this.
  const discarded = await withStatus(`Checking "${task.name}" for local changes`, () =>
    ctx.discards.discard(task.worktreePath),
  );
  const announcement = discarded ? describeDiscard(discarded) : undefined;
  if (announcement) {
    ctx.logger.warn(`Merge into "${task.name}": ${announcement}`);
    void vscode.window.showInformationMessage(announcement.split("\n")[0], "Show Log")
      .then((choice) => {
        if (choice === "Show Log") ctx.logger.show?.();
      });
  }

  // After the branch is chosen, not before. Committing or stashing is a real change to
  // the worktree, and doing it in front of a picker the user then escapes would leave
  // them having paid for a merge that never happened.
  const live = await ctx.service.getLiveState(task);
  const settlement = live.isDirty
    ? await settleChanges(ctx, task, live.changedFileCount)
    : "proceed";
  if (settlement === "cancelled") return;

  const outcome = await withStatus(`Merging "${branch}" into "${task.name}"`, () =>
    ctx.merges.mergeInto(task.worktreePath, branch),
  );

  // Restored whatever the merge did, including when it failed or conflicted. A stash
  // the user was told about and then never got back is worse than any merge outcome,
  // and a conflicted merge has already been aborted, so the tree is ready for it.
  if (settlement === "stashed") {
    const restored = await withStatus(`Restoring stashed changes in "${task.name}"`, () =>
      ctx.merges.stashPop(task.worktreePath),
    );
    if (!restored.ok) {
      const detail =
        restored.error.kind === "git"
          ? restored.error.error.stderr.trim() || restored.error.error.message
          : restored.error.message;
      void vscode.window.showWarningMessage(detail);
      ctx.logger.warn(`Harness [${task.name}] stash could not be restored: ${detail}`);
    }
  }

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
  report(ctx, task, branch, outcome.value, settlement);
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

  // Uncommitted work is deliberately NOT a blocker any more — see `settleChanges`.
  // A refusal telling the user to commit, in a UI with no way to commit, is a dead
  // end: the only route forward was a terminal, and from inside the extension it read
  // as the merge being broken.

  return undefined;
}

/** What to do about uncommitted work before merging. */
type Settlement = "committed" | "stashed" | "proceed" | "cancelled";

/**
 * Clears the way for a merge, or gets permission to merge over the work.
 *
 * A merge over uncommitted work cannot be cleanly undone: `git merge --abort`
 * restores the merge's changes, not the ones that were never committed. That is why
 * this used to be a refusal. But the refusal said "commit or stash them first" in a
 * UI that can do neither, so it was advice to leave the extension — and the three
 * things a user actually wants are all safe to offer here.
 *
 * "Merge anyway" is genuinely available rather than a trapdoor: git itself refuses a
 * merge that would overwrite local changes, and that refusal already arrives as the
 * `blocked` outcome with the paths named. What it permits is the common, harmless
 * case — local edits to files the merge does not touch.
 */
async function settleChanges(
  ctx: CommandContext,
  task: TaskWorkspace,
  changedFileCount: number,
): Promise<Settlement> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "Commit them, then merge",
        detail: "Commits everything, including untracked files, then merges.",
        action: "commit" as const,
      },
      {
        label: "Stash them, merge, then restore",
        detail:
          "Keeps the work uncommitted. If restoring conflicts with what the merge " +
          "brought in, the work stays in the stash and you resolve it by hand.",
        action: "stash" as const,
      },
      {
        label: "Merge anyway",
        detail:
          "Leaves the changes where they are. git refuses if the merge would " +
          "overwrite any of them, so this only proceeds when they are untouched.",
        action: "proceed" as const,
      },
    ],
    {
      title: `"${task.name}" has ${changedFileCount} uncommitted change(s)`,
      placeHolder: "What should happen to them?",
      ignoreFocusOut: true,
    },
  );
  if (!choice) return "cancelled";

  if (choice.action === "proceed") return "proceed";

  if (choice.action === "commit") {
    const message = await vscode.window.showInputBox({
      title: `Commit ${changedFileCount} change(s) in "${task.name}"`,
      prompt: "Commit message",
      value: `WIP: ${task.name}`,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? "A commit message is required." : undefined,
    });
    if (!message) return "cancelled";

    const result = await withStatus(`Committing in "${task.name}"`, () =>
      ctx.merges.commitAll(task.worktreePath, message),
    );
    if (!result.ok) {
      const detail =
        result.error.kind === "git"
          ? result.error.error.stderr.trim() || result.error.error.message
          : result.error.message;
      void vscode.window.showErrorMessage(`Could not commit: ${detail}`);
      return "cancelled";
    }
    return "committed";
  }

  const result = await withStatus(`Stashing changes in "${task.name}"`, () =>
    ctx.merges.stash(task.worktreePath, `task-workspaces: before merging into ${task.name}`),
  );
  if (!result.ok) {
    const detail =
      result.error.kind === "git"
        ? result.error.error.stderr.trim() || result.error.error.message
        : result.error.message;
    void vscode.window.showErrorMessage(`Could not stash: ${detail}`);
    return "cancelled";
  }
  return "stashed";
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
  settlement: Settlement,
): void {
  // Said out loud on success. A commit the user asked for is still a commit they did
  // not write themselves, and finding it later with no memory of it is how a "WIP"
  // commit ends up pushed to a shared branch.
  const settled =
    settlement === "committed"
      ? " Your changes were committed first."
      : settlement === "stashed"
        ? " Your stashed changes were restored."
        : "";

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
        `Merged "${branch}" into "${task.name}".${settled} Re-run the stage that failed.`,
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

