import { AgentSession } from "./agentSession";
import { TaskPipeline } from "./taskPipeline";
import { WorkspaceEnvironment } from "./workspaceEnvironment";

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
