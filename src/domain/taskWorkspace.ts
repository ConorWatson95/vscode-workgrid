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

  branchName: string;
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
