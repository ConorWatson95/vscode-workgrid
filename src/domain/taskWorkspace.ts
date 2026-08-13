import { AgentSession } from "./agentSession";
import { TaskPipeline } from "./taskPipeline";
import { WorkspaceEnvironment } from "./workspaceEnvironment";
import { WorktreeClaim } from "./worktreeLease";

export type TaskWorkspaceStatus =
  | "creating"
  | "ready"
  | "planning"
  | "implementing"
  | "awaiting-approval"
  | "reviewing"
  | "testing"
  | "completed"
  | "failed"
  | "archived";

/**
 * The central domain entity: an isolated development task backed by a git
 * worktree and branch. Persisted fields own friendly metadata; git remains the
 * source of truth for worktree existence, branch, changed files and commits.
 */
export interface TaskWorkspace {
  id: string;
  name: string;
  description?: string;

  repositoryRoot: string;
  worktreePath: string;

  /**
   * The branch the worktree is on *now*, refreshed from git by reconciliation.
   * Display truth, not identity — see `intendedBranch`.
   */
  branchName: string;
  /**
   * The branch this task is about, recorded once and never refreshed.
   *
   * Separate from `branchName` because git is the source of truth for what a
   * worktree *is* on, and reconciliation therefore adopts whatever it finds. That
   * made a stage running `git checkout` redefine the task rather than break it:
   * afterwards nothing was inconsistent, so nothing could be detected, and a review
   * reported truthfully about a tree nobody had asked about. Optional so tasks
   * created before this existed are backfilled rather than invalidated.
   */
  intendedBranch?: string;
  baseBranch: string;

  status: TaskWorkspaceStatus;
  createdAt: string;
  updatedAt: string;

  agent?: AgentSession;
  pipeline?: TaskPipeline;
  environment?: WorkspaceEnvironment;

  /**
   * Worktrees this task has claimed beyond its own — a promotion tree, a publish tree.
   *
   * Recorded because stages create worktrees and nothing knew about them: they were never
   * cleaned up, and overlap between two tasks could only be noticed by an agent reading
   * `git worktree list` and mentioning it in prose. See `domain/worktreeLease.ts`.
   * Optional, so tasks created before this existed stay valid.
   */
  worktreeClaims?: WorktreeClaim[];

  /**
   * The suggestion this task was started from, when it came from one.
   *
   * Two jobs, and the second is the reason it is worth persisting. It stops the
   * suggestion list offering work already under way — matching by `sourceId` + `ref`,
   * which is why identity is the source's own name for the item and never its title.
   * And it is a verified engineering fact a cold session cannot obtain at any price:
   * the ticket a task is *for* is in no diff, no branch and no brief, and every stage
   * on this project's routes is required to lead its commit subject with the Jira URL.
   *
   * Optional, so every task that predates suggestions stays valid.
   */
  origin?: TaskOrigin;
}

/** Where a task came from, when it came from a suggestion rather than a typed name. */
export interface TaskOrigin {
  sourceId: string;
  /** The source's own name for the item, e.g. an issue key. */
  ref: string;
  url?: string;
  /** When it was accepted, so the record says when the link was made. */
  at: string;
}

/**
 * Live git-derived facts about a task, merged into the tree at render time.
 * Never persisted — always recomputed from the worktree.
 */
export interface TaskWorkspaceLiveState {
  worktreeExists: boolean;
  isDirty: boolean;
  changedFileCount: number;
  /** Commits on this worktree's HEAD not yet on the base branch. */
  commitsAhead: number;
  currentBranch?: string;
}
