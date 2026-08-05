/**
 * Whether a task's worktree is still on the branch the task is about.
 *
 * Git is the source of truth for which branch a worktree is on, and
 * reconciliation refreshes the recorded name from it — which is right for
 * display, and wrong as an answer to "is this the right tree?". A stage that ran
 * `git checkout` silently *redefined* the task: the recorded branch followed the
 * worktree, so nothing was inconsistent afterwards and nothing could be detected.
 *
 * The failure is quiet and confident, which is the dangerous combination. A
 * migration-and-rollback review checked out another branch, found no migration
 * scripts, and reported that truthfully about a tree nobody had asked it about.
 *
 * Pure, so the comparison is testable without git.
 */

/** Normalised for comparison: git reports refs in several shapes. */
function normalizeBranch(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//, "")
    // A detached HEAD reports as the commit or as "HEAD"; either way it is not a
    // branch and must not compare equal to one.
    .toLowerCase();
}

export interface BranchMismatch {
  intended: string;
  actual: string;
  /** Ready to show or log: says what is wrong and what to do about it. */
  message: string;
}

/**
 * Reports a mismatch, or undefined when the worktree is where it should be.
 *
 * An unknown actual branch is *not* treated as a mismatch: git failing to report
 * a branch is a different problem from being on the wrong one, and refusing to
 * advance because a git call returned nothing would strand tasks for a reason the
 * message could not explain.
 */
export function branchMismatch(
  intended: string | undefined,
  actual: string | undefined,
): BranchMismatch | undefined {
  if (!intended?.trim() || !actual?.trim()) return undefined;
  if (normalizeBranch(intended) === normalizeBranch(actual)) return undefined;

  const isDetached = /^head$/i.test(actual.trim()) || /^[0-9a-f]{7,40}$/i.test(actual.trim());
  return {
    intended: intended.trim(),
    actual: actual.trim(),
    message: isDetached
      ? `This task's worktree is on a detached HEAD (${actual.trim()}) instead of "${intended.trim()}". ` +
        `Run "git checkout ${intended.trim()}" in the worktree, then advance again.`
      : // Says what it would have concluded, because the symptom of this is a stage
        // reporting an absence — "there are no migration scripts" — which reads as a
        // finding about the work rather than about the tree it looked in.
        `This task's worktree is on "${actual.trim()}" but the task is about ` +
        `"${intended.trim()}". A stage running here would report on the wrong branch, ` +
        `and an absence it found — no migration scripts, no changed files — would look ` +
        `like a finding rather than a wrong tree. Run "git checkout ${intended.trim()}" ` +
        `in the worktree, then advance again.`,
  };
}
