import { randomUUID } from "node:crypto";
import { TaskWorkspace, TaskWorkspaceLiveState } from "../domain/taskWorkspace";
import { GitWorktreeService, WorktreeError } from "../git/gitWorktreeService";
import { GitStatusService } from "../git/gitStatusService";
import { TaskRepository } from "../persistence/taskRepository";
import { Logger } from "../logging/logger";
import { Result, ok, err } from "../utilities/result";
import { buildBranchName, slugify } from "../utilities/branchName";
import { buildWorktreePath } from "../utilities/pathUtilities";
import {
  reconcileTasks,
  ReconciliationResult,
} from "./taskReconciliationService";

function normalizePathLike(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Injectable clock/id so the service stays deterministic under test. */
export interface ServiceClock {
  now(): string;
  newId(): string;
}

export const defaultClock: ServiceClock = {
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export interface ProposeTaskInput {
  repositoryRoot: string;
  name: string;
  branchPrefix: string;
  configuredParentDir: string;
}

export interface TaskProposal {
  branchName: string;
  worktreePath: string;
  slug: string;
}

export interface CreateTaskInput extends ProposeTaskInput {
  description?: string;
  baseBranch: string;
}

export type ServiceError =
  | { kind: "validation"; message: string }
  | { kind: "worktree"; error: WorktreeError }
  | { kind: "notFound"; message: string };

export class TaskWorkspaceService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly worktrees: GitWorktreeService,
    private readonly status: GitStatusService,
    private readonly logger: Logger,
    private readonly clock: ServiceClock = defaultClock,
  ) {}

  /** Computes the branch name and worktree path for a task, for preview. */
  proposeTask(input: ProposeTaskInput): Result<TaskProposal, ServiceError> {
    const branch = buildBranchName(input.branchPrefix, input.name);
    if (!branch.ok) {
      return err({ kind: "validation", message: branch.error });
    }
    const slug = slugify(input.name);
    const path = buildWorktreePath({
      repositoryRoot: input.repositoryRoot,
      slug,
      configuredParentDir: input.configuredParentDir,
    });
    if (!path.ok) {
      return err({ kind: "validation", message: path.error });
    }
    return ok({ branchName: branch.value, worktreePath: path.value, slug });
  }

  async createTask(
    input: CreateTaskInput,
    signal?: AbortSignal,
  ): Promise<Result<TaskWorkspace, ServiceError>> {
    const proposal = this.proposeTask(input);
    if (!proposal.ok) return proposal;

    // Guard against duplicate branch assignment within our own records.
    const existing = await this.repository.getByRepository(input.repositoryRoot);
    if (existing.some((t) => t.branchName === proposal.value.branchName)) {
      return err({
        kind: "validation",
        message: `A task already uses branch "${proposal.value.branchName}".`,
      });
    }

    const created = await this.worktrees.createWorktree(
      input.repositoryRoot,
      {
        branchName: proposal.value.branchName,
        worktreePath: proposal.value.worktreePath,
        baseBranch: input.baseBranch,
      },
      signal,
    );
    if (!created.ok) {
      return err({ kind: "worktree", error: created.error });
    }

    const now = this.clock.now();
    const task: TaskWorkspace = {
      id: this.clock.newId(),
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      repositoryRoot: input.repositoryRoot,
      worktreePath: created.value.path,
      branchName: proposal.value.branchName,
      baseBranch: input.baseBranch,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.save(task);
    this.logger.info(`Created task "${task.name}" on ${task.branchName}`);
    return ok(task);
  }

  /**
   * Imports an existing (untracked) git worktree as a tracked task. Used when
   * reconciliation surfaces a worktree with no matching stored task.
   */
  async adoptWorktree(
    repositoryRoot: string,
    worktreePath: string,
    branchName: string,
    options: { name: string; baseBranch: string; description?: string },
  ): Promise<Result<TaskWorkspace, ServiceError>> {
    const existing = await this.repository.getByRepository(repositoryRoot);
    if (existing.some((t) => normalizePathLike(t.worktreePath) === normalizePathLike(worktreePath))) {
      return err({
        kind: "validation",
        message: "This worktree is already tracked by a task.",
      });
    }

    const now = this.clock.now();
    const task: TaskWorkspace = {
      id: this.clock.newId(),
      name: options.name.trim(),
      description: options.description?.trim() || undefined,
      repositoryRoot,
      worktreePath,
      branchName,
      baseBranch: options.baseBranch,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.save(task);
    this.logger.info(`Adopted worktree "${worktreePath}" as task "${task.name}".`);
    return ok(task);
  }

  /** Loads tasks for a repository, reconciling against live git worktrees. */
  async listTasks(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<Result<ReconciliationResult, ServiceError>> {
    const stored = await this.repository.getByRepository(repositoryRoot);
    const live = await this.worktrees.listWorktrees(repositoryRoot, signal);
    if (!live.ok) {
      return err({ kind: "worktree", error: live.error });
    }

    const result = reconcileTasks(stored, live.value, repositoryRoot);
    // Persist any reconciliation changes (e.g. tasks marked failed).
    for (const reconciled of result.tasks) {
      if (reconciled.changed) {
        await this.repository.save({
          ...reconciled.task,
          updatedAt: this.clock.now(),
        });
      }
    }
    return ok(result);
  }

  async getLiveState(
    task: TaskWorkspace,
    signal?: AbortSignal,
  ): Promise<TaskWorkspaceLiveState> {
    const status = await this.status.getStatus(task.worktreePath, signal);
    if (!status.ok) {
      return {
        worktreeExists: false,
        isDirty: false,
        changedFileCount: 0,
        commitsAhead: 0,
      };
    }
    const ahead = await this.status.getCommitsAhead(
      task.worktreePath,
      task.baseBranch,
      signal,
    );
    return {
      worktreeExists: true,
      isDirty: status.value.isDirty,
      changedFileCount: status.value.changedFileCount,
      commitsAhead: ahead.ok ? ahead.value : 0,
      currentBranch: status.value.branch,
    };
  }

  async archiveTask(id: string): Promise<Result<TaskWorkspace, ServiceError>> {
    const task = await this.repository.get(id);
    if (!task) return err({ kind: "notFound", message: "Task not found." });
    const updated: TaskWorkspace = {
      ...task,
      status: "archived",
      updatedAt: this.clock.now(),
    };
    await this.repository.save(updated);
    return ok(updated);
  }

  async unarchiveTask(id: string): Promise<Result<TaskWorkspace, ServiceError>> {
    const task = await this.repository.get(id);
    if (!task) return err({ kind: "notFound", message: "Task not found." });
    const updated: TaskWorkspace = {
      ...task,
      status: "ready",
      updatedAt: this.clock.now(),
    };
    await this.repository.save(updated);
    return ok(updated);
  }

  async removeTask(
    id: string,
    options: { force: boolean },
    signal?: AbortSignal,
  ): Promise<Result<void, ServiceError>> {
    const task = await this.repository.get(id);
    if (!task) return err({ kind: "notFound", message: "Task not found." });

    const removed = await this.worktrees.removeWorktree(
      task.repositoryRoot,
      task.worktreePath,
      { force: options.force },
      signal,
    );
    if (!removed.ok) {
      return err({ kind: "worktree", error: removed.error });
    }
    await this.repository.delete(id);
    this.logger.info(`Removed task "${task.name}" and its worktree.`);
    return ok(undefined);
  }
}
