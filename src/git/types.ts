export interface GitWorktree {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Full commit hash currently checked out, if any. */
  head?: string;
  /** Short branch name (without `refs/heads/`), if on a branch. */
  branch?: string;
  /** True when HEAD is detached. */
  detached: boolean;
  /** True for the primary (bare or main) worktree entry. */
  bare: boolean;
  /** True when git reports the worktree as locked. */
  locked: boolean;
  /** True when git reports the worktree as prunable (its dir is missing). */
  prunable: boolean;
}

export interface GitStatus {
  /** True when there are any staged, unstaged or untracked changes. */
  isDirty: boolean;
  /** Count of changed paths (staged + unstaged + untracked). */
  changedFileCount: number;
  /** Current branch name, or undefined when detached. */
  branch?: string;
}

export interface GitDiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface CreateWorktreeOptions {
  branchName: string;
  worktreePath: string;
  baseBranch: string;
}

export interface RemoveWorktreeOptions {
  /** Remove even with uncommitted changes. Requires explicit confirmation. */
  force?: boolean;
}
