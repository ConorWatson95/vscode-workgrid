import { ArchivedSession } from "../agents/sessionArchive";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { planCleanup } from "../domain/worktreeLease";
import { Logger } from "../logging/logger";
import { ArchivedTaskHistory } from "../persistence/archivedHistoryFiles";
import { TaskRepository } from "../persistence/taskRepository";
import { Result, ok } from "../utilities/result";
import { ServiceError, TaskWorkspaceService } from "./taskWorkspaceService";
import { WorktreeClaimService } from "./worktreeClaimService";

/**
 * Removing a task: its transcripts archived, the worktrees its stages made tidied away,
 * its own worktree removed, and the task forgotten. The branch is always kept: a
 * worktree is a checkout that can be remade, a branch may hold the only copy of its
 * commits.
 *
 * Out of the VS Code command so Claude can remove a task too. Each client asks its own
 * questions and stops its own processes; this is everything after the confirmation, so
 * the two cannot remove a task two different ways.
 */

export interface TaskRemovalDeps {
  service: Pick<TaskWorkspaceService, "getLiveState" | "removeTask">;
  repository: Pick<TaskRepository, "delete">;
  claims?: Pick<WorktreeClaimService, "planFor" | "apply">;
  archive: { archiveWorktree(homeDir: string, worktreePath: string, taskId: string): ArchivedSession[] };
  recordHistory(entry: ArchivedTaskHistory): Promise<void>;
  homeDir: string;
  logger: Logger;
  now(): string;
}

export interface TaskRemovalPlan {
  /** Uncommitted changes in the task's own worktree, which removing it discards. */
  changedFileCount: number;
  claims: ReturnType<typeof planCleanup>;
  /** What else goes and what stays, one line each, for the confirmation. */
  detail: string[];
}

/**
 * Planned before the confirmation, so it can say what else goes. A route's stages create
 * worktrees the operator never asked for by name — a promote/* tree per environment — and
 * removing the task without them left the directories behind with nothing pointing at
 * them. Conservative, as at route completion: agreeing to remove a task is not agreeing
 * to discard uncommitted work in a tree you may not know exists.
 */
export async function planTaskRemoval(deps: TaskRemovalDeps, task: TaskWorkspace): Promise<TaskRemovalPlan> {
  const live = await deps.service.getLiveState(task);
  const claims =
    deps.claims && (task.worktreeClaims ?? []).length > 0
      ? await deps.claims.planFor(task)
      : { remove: [], retain: [] };
  const detail = [`Branch ${task.branchName} is kept.`];
  if (claims.remove.length > 0) detail.push(`Also removing ${claims.remove.length} worktree(s) this task created.`);
  if (claims.retain.length > 0) {
    detail.push(`Keeping ${claims.retain.length}: ${claims.retain.map((r) => r.reason).join("; ")}.`);
  }
  return { changedFileCount: live.isDirty ? Math.max(1, live.changedFileCount) : 0, claims, detail };
}

export async function removeTaskCompletely(
  deps: TaskRemovalDeps,
  task: TaskWorkspace,
  plan: TaskRemovalPlan,
  options: { force: boolean },
  step: (label: string) => void = () => undefined,
): Promise<Result<void, ServiceError>> {
  // Before the worktree, and its transcripts with it, vanish.
  step("archiving agent transcripts");
  const sessions = deps.archive.archiveWorktree(deps.homeDir, task.worktreePath, task.id);
  if (sessions.length > 0) {
    try {
      await deps.recordHistory({
        taskId: task.id,
        name: task.name,
        branchName: task.branchName,
        archivedAt: deps.now(),
        sessions,
      });
      deps.logger.info(`Archived ${sessions.length} session(s) for "${task.name}".`);
    } catch (error) {
      deps.logger.warn(`Archived ${sessions.length} session(s) for "${task.name}" but could not record them: ${String(error)}`);
    }
  }

  // Before the task's own worktree, because `apply` re-reads the task to drop the claims
  // it cleared — once `removeTask` has run there is no task to re-read, so the claims
  // would be dropped into nothing while the directories stayed.
  if (deps.claims && plan.claims.remove.length > 0) {
    step(`removing ${plan.claims.remove.length} worktree(s) this task created`);
    const outcome = await deps.claims.apply(task, plan.claims, deps.now());
    for (const failure of outcome.failed) {
      deps.logger.warn(`Could not remove "${failure.path}" while removing "${task.name}": ${failure.reason}`);
    }
  }

  step("removing the worktree");
  return deps.service.removeTask(task.id, options);
}

/**
 * Stops tracking a task whose worktree git would not remove — a locked file on Windows,
 * usually. The folder may still be on disk; the task no longer lingers in the list.
 */
export async function untrackTask(deps: Pick<TaskRemovalDeps, "repository" | "logger">, task: TaskWorkspace): Promise<Result<void, ServiceError>> {
  await deps.repository.delete(task.id);
  deps.logger.info(`Stopped tracking "${task.name}"; its worktree may remain at ${task.worktreePath}.`);
  return ok(undefined);
}

export function describeWorktreeError(error: unknown): string {
  const e = error as { kind?: string; message?: string; error?: { message?: string } };
  if (e?.kind === "dirty" && e.message) return e.message;
  if (e?.kind === "unmerged" && e.message) return e.message;
  if (e?.kind === "validation" && e.message) return e.message;
  if (e?.error?.message) return `Git error: ${e.error.message}`;
  return "Failed to remove task workspace.";
}

/** A service error from removal, as one sentence. */
export function describeRemovalError(error: ServiceError): string {
  return error.kind === "worktree" ? describeWorktreeError(error.error) : error.message;
}
