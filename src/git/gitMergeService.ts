import { GitClient } from "./gitClient";
import { WorktreeError } from "./gitWorktreeService";
import { MergeOutcome, classifyMerge, leavesMergeInProgress } from "./mergeOutcome";
import { parseBranchNames } from "./branchParser";
import { Result, ok, err } from "../utilities/result";

/**
 * Brings another branch into a task's worktree.
 *
 * A merge rather than a rebase, deliberately: a rebase rewrites the commits a
 * pipeline's recorded stage activity refers to, so a report written before it would
 * afterwards cite hashes that no longer exist.
 *
 * Safe with respect to the review rules, which is the non-obvious part. Reviews are
 * keyed off `getChangedPaths`, and that diffs `baseBranch...HEAD` — three dots, so
 * against the merge base. Merging the base branch *in* therefore does not add the
 * base's own changes to the task's diff, and cannot oblige reviews for work the task
 * did not do.
 */
export class GitMergeService {
  constructor(private readonly git: GitClient) {}

  /** Local branch names, for choosing something other than the task's base. */
  async listBranches(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<Result<string[], WorktreeError>> {
    const result = await this.git.run(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd: repositoryRoot, signal },
    );
    if (!result.ok) return err({ kind: "git", error: result.error });
    return ok(parseBranchNames(result.value.stdout));
  }

  /**
   * Merges `branch` into whatever the worktree is on.
   *
   * Conflicts are aborted rather than left in place. A worktree mid-merge has
   * conflict markers in its files and unmerged entries in its index, and both feed
   * the changed-paths the rules engine reads — so leaving one would let a stalled
   * merge decide which reviews a task owes. The abort restores the tree, and the
   * conflicting paths are still reported so the abort is not silent.
   */
  async mergeInto(
    worktreePath: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<Result<MergeOutcome, WorktreeError>> {
    if (!branch.trim()) {
      return err({ kind: "validation", message: "No branch to merge was given." });
    }

    // `failureIsAnswer`: a conflict is git answering the question, not git breaking.
    // Logging it as an error would put a red line in the log for a normal outcome.
    const result = await this.git.run(["merge", "--no-edit", branch], {
      cwd: worktreePath,
      signal,
      failureIsAnswer: true,
    });

    const outcome = result.ok
      ? classifyMerge({ exitCode: 0, stdout: result.value.stdout, stderr: result.value.stderr })
      : classifyMerge({
          exitCode: result.error.exitCode,
          // The conflicting paths are here, not in stderr — see `GitError.stdout`.
          stdout: result.error.stdout,
          stderr: result.error.stderr,
        });

    if (leavesMergeInProgress(outcome)) {
      const aborted = await this.abort(worktreePath, signal);
      if (!aborted.ok) return aborted;
    }
    return ok(outcome);
  }

  /**
   * Stages everything, including untracked files, and commits it.
   *
   * Exists because the merge command refused a dirty worktree and then offered no way
   * out: there is no commit UI in the extension, so "commit or stash them first" meant
   * leaving for a terminal, and the refusal read as the feature being broken.
   *
   * `add -A` rather than `add -u`: the case that prompted this was a stage's untracked
   * output, and a commit that silently left it behind would be worse than refusing —
   * the merge would proceed and the work would still be uncommitted.
   */
  async commitAll(
    worktreePath: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<Result<void, WorktreeError>> {
    if (!message.trim()) {
      return err({ kind: "validation", message: "A commit message is required." });
    }

    const staged = await this.git.run(["add", "-A"], { cwd: worktreePath, signal });
    if (!staged.ok) return err({ kind: "git", error: staged.error });

    const committed = await this.git.run(["commit", "-m", message.trim()], {
      cwd: worktreePath,
      signal,
    });
    if (!committed.ok) return err({ kind: "git", error: committed.error });
    return ok(undefined);
  }

  /**
   * Sets uncommitted work aside, including untracked files.
   *
   * `-u` for the same reason `commitAll` uses `add -A`: a stash that leaves untracked
   * files in the tree has not made the tree clean, so the merge it was meant to unblock
   * is still blocked — and the user has been told their work was safely put away.
   */
  async stash(
    worktreePath: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<Result<void, WorktreeError>> {
    const result = await this.git.run(["stash", "push", "-u", "-m", message], {
      cwd: worktreePath,
      signal,
    });
    if (!result.ok) return err({ kind: "git", error: result.error });
    return ok(undefined);
  }

  /**
   * Restores the most recent stash.
   *
   * A failure here is the one outcome of the whole flow that leaves work somewhere the
   * user did not put it, so the error says where to find it rather than only that it
   * went wrong. The stash still exists after a failed pop — that is what makes this
   * recoverable at all.
   */
  async stashPop(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<Result<void, WorktreeError>> {
    const result = await this.git.run(["stash", "pop"], {
      cwd: worktreePath,
      signal,
      failureIsAnswer: true,
    });
    if (!result.ok) {
      return err({
        kind: "validation",
        message:
          `Your work is still safe in the stash, but it could not be restored ` +
          `automatically (${result.error.stderr.trim() || result.error.message.trim()}). ` +
          `Run "git stash pop" in ${worktreePath} and resolve it by hand.`,
      });
    }
    return ok(undefined);
  }

  private async abort(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<Result<void, WorktreeError>> {
    const result = await this.git.run(["merge", "--abort"], {
      cwd: worktreePath,
      signal,
    });
    if (!result.ok) {
      // Reported rather than swallowed: the worktree is now part-merged and the
      // caller's "nothing changed" reassurance would be false.
      return err({
        kind: "validation",
        message:
          `The merge conflicted and could not be undone (${result.error.message.trim()}). ` +
          `Resolve it in ${worktreePath}, or run "git merge --abort" there.`,
      });
    }
    return ok(undefined);
  }
}
