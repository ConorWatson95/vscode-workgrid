/**
 * The commits a task actually made, recorded as they happen rather than reconstructed.
 *
 * ## Why reconstruction does not work
 *
 * Four ways to recover a task's commit set were tried against the live repository on
 * 7 Sep 2026, and the topology defeats all of them once a branch is long-lived:
 *
 * - **Ticket keys in commit subjects**, which is what the promotion checks do today. A
 *   fix to the check itself, made while working a ticket, leads with that ticket's URL
 *   by convention and is indistinguishable from the work. It also misses commits with
 *   no ticket in the subject — two of NMGB-2533's twelve.
 * - **`rev-list <branch> ^<baseBranch>`** alone. Correct, and empty once the work is
 *   promoted, which is exactly when a promotion check asks.
 * - **`rev-list <branch> ^<forkPoint>`** from `TaskWorkspace.baseCommit`. Exact for a
 *   clean short branch — NMGB-2533 gives precisely its 12 — and wrong for a branch that
 *   has integrated its base: `feature/renaultgb-myrewards-summary` yielded **338**.
 * - **The same with `--first-parent --no-merges`**, which is the obvious repair and does
 *   not hold either. That branch has had DEV merged into it 53 times, and enough of
 *   those put DEV's side on the branch's own line that the walk returned 103 commits
 *   spanning six other tickets. A commit sampled from it is on `origin/DEV` and fifteen
 *   other branches.
 *
 * So the set is not a function of the graph. It has to be observed.
 *
 * ## What is observed, and why this shape
 *
 * At each stage boundary, `rev-list <branch> ^<baseBranch>` — the commits on the branch
 * that the base does not yet have — and the **union of that over the task's life** is
 * the answer. Each commit is captured in the window between being made and being
 * promoted, and a base commit merged into the branch never appears at all, because it
 * is on the base. That is the property the fork-point walks lacked.
 *
 * The one gap is stated rather than guarded: a commit made *and* promoted between two
 * observations is never seen. Stages observe often enough that this is rare, and the
 * alternative — observing on every tree render — costs a git spawn per refresh to close
 * a hole that a promote stage's own boundary already covers.
 *
 * ## Append-only, and on the task
 *
 * Recorded on `TaskWorkspace`, not on the pipeline, for `TaskReference.origin`'s reason:
 * a commit exists in git whatever the pipeline later does with it, so a revert that
 * discards a stage's output must not discard the record of history that stage made.
 *
 * And never removed. A commit that has since been promoted is still one this task made
 * — removing it when it leaves `rev-list <branch> ^<base>` would empty the set at the
 * moment it becomes useful, which is precisely the failure of asking git directly.
 *
 * Pure and vscode-free.
 */

/** One commit this task made, with what was running when it was first seen. */
export interface RecordedCommit {
  /** Full sha. Abbreviations are not identity; two clones abbreviate differently. */
  commit: string;
  /** When it was first observed, never updated. */
  at: string;
  /**
   * The stage whose boundary observed it, when a stage did.
   *
   * Absent means unattributed rather than unowned — a commit made by hand between
   * advances is a real commit of this task's, and dropping it to keep attribution tidy
   * would reintroduce the incompleteness this module exists to end.
   */
  stageId?: string;
  subtaskId?: string;
}

/** Where an observation came from, for attribution only. */
export interface CommitObservation {
  at: string;
  stageId?: string;
  subtaskId?: string;
}

/**
 * Adds newly observed commits to what a task already records.
 *
 * Returns the existing list unchanged when nothing is new, so a caller can skip a write
 * — stage boundaries observe constantly and the state file is read-modify-write.
 *
 * Order is oldest-first by observation, which is the order they were made in as far as
 * anything here can know. `rev-list` returns newest first, so the caller's list is
 * reversed on the way in rather than sorted afterwards: a commit's date is not its
 * position on a branch, and re-sorting by date would reorder a cherry-pick.
 */
export function recordCommits(
  existing: readonly RecordedCommit[] | undefined,
  observed: readonly string[],
  origin: CommitObservation,
): RecordedCommit[] {
  const current = existing ? [...existing] : [];
  const known = new Set(current.map((entry) => entry.commit));

  const added = [...observed]
    .reverse()
    .filter((commit) => commit && !known.has(commit))
    .filter((commit) => {
      // Guards against the same sha appearing twice in one observation, which
      // `rev-list` will not do but a caller assembling several might.
      if (known.has(commit)) return false;
      known.add(commit);
      return true;
    })
    .map((commit) => ({
      commit,
      at: origin.at,
      ...(origin.stageId ? { stageId: origin.stageId } : {}),
      ...(origin.subtaskId ? { subtaskId: origin.subtaskId } : {}),
    }));

  return added.length === 0 ? current : [...current, ...added];
}

/** Just the shas, oldest first. What a check enumerating this task's work wants. */
export function commitShas(commits: readonly RecordedCommit[] | undefined): string[] {
  return (commits ?? []).map((entry) => entry.commit);
}
