import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { resolveTaskArg } from "./suggestionCommands";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { foreignReferences, ForeignReferences } from "../domain/baseCommitProposal";
import { taskTicket } from "../domain/ticketReference";
import { loadHarness } from "../services/reviewRulesService";

/**
 * Records the commit a task's branch was cut from, for a task that predates the field.
 *
 * The reason this is a command rather than a migration: `baseCommit` cannot be
 * backfilled by computation. `merge-base(branch, base)` is the fork point only while
 * the branch is unmerged, and afterwards it is the branch's own tip — so on the tasks
 * that most need it, the obvious derivation is confidently wrong, and a wrong value
 * enumerates another ticket's commits and demands they be promoted. The branch's
 * reflog does hold the answer, but reflogs are local to a clone and expire, so it is
 * available for some tasks and not others. See `domain/baseCommitProposal.ts`.
 *
 * Hence: propose, show what the proposal would establish, and let a person agree to it.
 * The same shape as the assessment stage, which records its conclusions and leaves
 * `approveStage` to apply them, and as `suggestionLookup`, where a ticket reference is
 * verified rather than typed.
 */
export async function recordBaseCommitCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const task = resolveTaskArg(arg);
  if (!task) return;

  if (task.baseCommit) {
    // The service refuses this too; said here so the refusal names the existing value.
    void vscode.window.showWarningMessage(
      `"${task.name}" already records ${short(task.baseCommit)} as its base commit. ` +
        "Changing it would silently re-scope every check that enumerates this task's " +
        "commits.",
    );
    return;
  }

  const proposal = await ctx.service.proposeBaseCommit(task);
  const candidate = proposal.ok
    ? await confirmProposal(
        task,
        proposal.value,
        contamination(ctx, task, proposal.value.subjects),
      )
    : await askForCommit(task, message(proposal.error));
  if (!candidate) return;

  const result = await ctx.service.recordBaseCommit(task, candidate);
  if (!result.ok) {
    void vscode.window.showErrorMessage(message(result.error));
    return;
  }

  ctx.tree.refresh();
  void vscode.window.showInformationMessage(
    `"${result.value.name}" was cut from ${short(candidate)}. Checks can now enumerate ` +
      "its own commits rather than inferring them from commit subjects.",
  );
}

/**
 * Shows the proposal and what it would establish.
 *
 * **The commit set is the thing being agreed to, not the hash** — a hash is unreadable,
 * and the question a person can actually answer is "are those this task's commits?".
 * On NMGB-2533 that is what made it checkable by eye: twelve commits, all plainly the
 * task's own, including two whose subjects carry no ticket and which the check that
 * infers the set from subjects was scoping wrong.
 *
 * Modal, because it is the one moment the value can be got wrong cheaply and the cost
 * of getting it wrong is silent afterwards.
 */
async function confirmProposal(
  task: TaskWorkspace,
  proposal: { commit: string; createdFrom: string; subjects: string[] },
  foreign: ForeignReferences,
): Promise<string | undefined> {
  const branch = task.intendedBranch ?? task.branchName;
  const mismatch =
    normalizeRef(proposal.createdFrom) === normalizeRef(task.baseBranch)
      ? ""
      : `\n\nThe reflog says it was cut from ${proposal.createdFrom}, while the task ` +
        `records its base branch as ${task.baseBranch}. Worth a look before agreeing.`;

  // The signal that makes a bad proposal obvious. A fork point is wrong on a branch
  // that has integrated its base, and the tell is other tickets' work in the set:
  // `feature/renaultgb-myrewards-summary` proposed 103 commits spanning six of them.
  // Stated before the list, because it is the reason to decline and nobody reading a
  // long list of subjects will derive it for themselves.
  const contaminated =
    foreign.commits > 0
      ? `\n\n${foreign.commits} of these reference other work ` +
        `(${foreign.refs.slice(0, 6).join(", ")}). So the proposal has swept in commits ` +
        "this task did not make, which is what happens on a branch that has had its " +
        "base merged in. Decline unless you can account for them."
      : "";

  const RECORD = "Record";
  const DIFFERENT = "Enter a different commit";
  const choice = await vscode.window.showInformationMessage(
    `Record ${short(proposal.commit)} as the base commit for "${task.name}"?`,
    {
      modal: true,
      detail:
        `The reflog says ${branch} was created from ${proposal.createdFrom} at that ` +
        `commit. It would establish these ${proposal.subjects.length} commit(s) as the ` +
        `task's own:\n\n${preview(proposal.subjects)}${contaminated}${mismatch}`,
    },
    RECORD,
    DIFFERENT,
  );
  if (choice === RECORD) return proposal.commit;
  if (choice === DIFFERENT) return askForCommit(task);
  return undefined;
}

/**
 * The fall-back for a branch whose reflog cannot say.
 *
 * Kept rather than treated as a dead end: a trimmed reflog is an ordinary state on an
 * older branch, and the operator often knows exactly which commit it was — or can find
 * it far more cheaply than the harness can. Validation is left to the service, which
 * checks the commit is actually on the branch.
 */
async function askForCommit(
  task: TaskWorkspace,
  reason?: string,
): Promise<string | undefined> {
  const typed = await vscode.window.showInputBox({
    title: `Base commit for "${task.name}"`,
    prompt:
      (reason ? `${reason} ` : "") +
      "It is checked against the branch before it is recorded.",
    placeHolder: "a commit on this task's branch, e.g. 7fe00c7e8",
    validateInput: (value) =>
      value.trim().length === 0 || /^[0-9a-fA-F]{7,40}$/.test(value.trim())
        ? undefined
        : "That is not a commit hash.",
  });
  return typed?.trim() || undefined;
}

/**
 * Other tickets' refs among the proposed commits, by the project's own convention.
 *
 * The pattern is the project's, never the extension's: leading every commit with a
 * ticket key is how one repository happens to work, so it comes from that project's
 * suggestion source, and a project declaring none gets the default shape rather than a
 * wrong one. Harness problems are not surfaced here -- this is a warning about a
 * warning, and the caller has no stake in them.
 */
function contamination(
  ctx: CommandContext,
  task: TaskWorkspace,
  subjects: string[],
): ForeignReferences {
  const root = ctx.resolveRepositoryRoot();
  const declared = root
    ? loadHarness(root, {
        configuredPath: ctx.configuration.harnessConfigPath(ctx.repositoryUri()),
      }).suggestionSources.find((source) => source.refPattern)?.refPattern
    : undefined;
  let pattern: RegExp | undefined;
  try {
    pattern = declared ? new RegExp(declared) : undefined;
  } catch {
    // An uncompilable pattern is the project's problem, not this dialog's, and it is
    // rejected where it is parsed. Falling back beats refusing to warn.
    pattern = undefined;
  }
  return foreignReferences(subjects, taskTicket(task), pattern);
}

/** First few subjects, since a long list turns a dialog into something nobody reads. */
function preview(subjects: string[]): string {
  const shown = subjects.slice(0, 8);
  const rest = subjects.length - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n… and ${rest} more` : "");
}

function short(commit: string): string {
  return commit.slice(0, 9);
}

/** `origin/DEV` and `DEV` are the same branch for the purpose of noticing a mismatch. */
function normalizeRef(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "").toLowerCase();
}

function message(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : "Could not record the base commit.";
}
