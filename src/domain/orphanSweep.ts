/**
 * Which untracked worktrees a bulk removal may take, and which it must leave.
 *
 * The command that uses this is a `vscode` shell over it, because the decision is the
 * part worth pinning: this is the only place in the runtime that deletes several
 * directories on one click, and each rule below is the difference between a tidy-up and
 * losing somebody's work.
 *
 * What is *not* decided here, deliberately: whether a worktree is untracked at all.
 * `reconcileTasks` owns that, and it already excludes a task's own worktree, the primary
 * worktree, and every tree a stage claimed or borrowed. Re-deriving it from a worktree
 * listing is precisely the mistake this feature exists to make unnecessary.
 */

/** One untracked worktree, with as much as could be read about its working tree. */
export interface InspectedOrphan {
  path: string;
  branch?: string;
  /**
   * Absent when the status could not be read at all — which is not the same fact as a
   * clean tree, and is treated as the opposite of one.
   */
  changedFileCount?: number;
}

export interface OrphanSweep {
  /** Safe to remove: read successfully, and nothing in the working tree. */
  removable: InspectedOrphan[];
  /** Left alone, because there is something to lose or nothing could be established. */
  kept: InspectedOrphan[];
}

/**
 * Partitions untracked worktrees into those a sweep may remove and those it must keep.
 *
 * Two rules, and both choose the same direction:
 *
 * - **Anything with a change in it is kept.** The per-row command offers to discard
 *   changes, which is defensible when somebody is looking at one worktree and its change
 *   count. In bulk it would make "remove all" the cheapest way in the whole extension to
 *   lose uncommitted work, so the sweep declines and says which ones it declined on.
 *   `git status --porcelain` counts untracked files as changes, which is also what
 *   `git worktree remove` refuses on, so the two agree without this having to model git.
 * - **An unreadable status is kept.** Absence of measurement is not permission to delete
 *   a directory — the direction `WorktreeDiscardService` and the unmeasured-wait rule
 *   already choose. Defaulting the other way would make a momentarily unreadable git the
 *   one condition under which a sweep destroys the most.
 */
export function planOrphanSweep(orphans: InspectedOrphan[]): OrphanSweep {
  const removable: InspectedOrphan[] = [];
  const kept: InspectedOrphan[] = [];
  for (const orphan of orphans) {
    if (orphan.changedFileCount === 0) removable.push(orphan);
    else kept.push(orphan);
  }
  return { removable, kept };
}
