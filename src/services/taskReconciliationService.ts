import { TaskWorkspace } from "../domain/taskWorkspace";
import { GitWorktree } from "../git/types";
import { normalizeRoot } from "../persistence/taskRepository";

export interface ReconciledTask {
  task: TaskWorkspace;
  /** True when a live git worktree backs this task. */
  worktreeExists: boolean;
  /** Set when reconciliation changed the persisted task (needs saving). */
  changed: boolean;
}

export interface OrphanWorktree {
  worktree: GitWorktree;
}

export interface ReconciliationResult {
  tasks: ReconciledTask[];
  /** Git worktrees with no matching stored task (candidates for adoption). */
  orphans: OrphanWorktree[];
}

/**
 * Pure reconciliation between stored tasks and live git worktrees.
 *
 * - Matched: task keeps its metadata; branch is refreshed from git.
 * - Stored-but-missing worktree: marked `failed` (surfaced, never deleted).
 * - Worktree with no task: reported as an orphan for optional adoption.
 *
 * The primary/bare worktree is never treated as an orphan.
 */
export function reconcileTasks(
  storedTasks: TaskWorkspace[],
  liveWorktrees: GitWorktree[],
  repositoryRoot: string,
): ReconciliationResult {
  const worktreeByPath = new Map<string, GitWorktree>();
  for (const wt of liveWorktrees) {
    worktreeByPath.set(normalizePath(wt.path), wt);
  }

  const matchedPaths = new Set<string>();
  const tasks: ReconciledTask[] = [];

  for (const task of storedTasks) {
    const key = normalizePath(task.worktreePath);
    const worktree = worktreeByPath.get(key);

    if (!worktree) {
      const changed = task.status !== "failed" && task.status !== "archived";
      tasks.push({
        task: changed ? { ...task, status: "failed" } : task,
        worktreeExists: false,
        changed,
      });
      continue;
    }

    matchedPaths.add(key);
    const refreshedBranch = worktree.branch ?? task.branchName;
    const branchChanged = refreshedBranch !== task.branchName;
    // Backfilled once, from the recorded name rather than from git: a task created
    // before this field existed may already be sitting on a switched branch, and
    // taking git's answer would enshrine the wrong branch as the intended one.
    const backfill = task.intendedBranch === undefined;
    tasks.push({
      task:
        branchChanged || backfill
          ? {
              ...task,
              branchName: refreshedBranch,
              intendedBranch: task.intendedBranch ?? task.branchName,
            }
          : task,
      worktreeExists: true,
      changed: branchChanged || backfill,
    });
  }

  const orphans: OrphanWorktree[] = [];
  for (const wt of liveWorktrees) {
    if (wt.bare) continue;
    if (isPrimaryWorktree(wt, repositoryRoot)) continue;
    const key = normalizePath(wt.path);
    if (!matchedPaths.has(key)) {
      orphans.push({ worktree: wt });
    }
  }

  return { tasks, orphans };
}

/** Determines which live worktree is the repository's primary worktree. */
export function isPrimaryWorktree(
  worktree: GitWorktree,
  repositoryRoot: string,
): boolean {
  return normalizeRoot(worktree.path) === normalizeRoot(repositoryRoot);
}

function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
