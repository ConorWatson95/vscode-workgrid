import { randomUUID } from "node:crypto";
import {
  TaskOrigin,
  TaskWorkspace,
  TaskWorkspaceLiveState,
} from "../domain/taskWorkspace";
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
  /**
   * The suggestion this task was started from, when it came from one.
   *
   * Recorded at creation rather than attached afterwards: it is what stops the
   * suggestion list offering work already under way, and a link made in a second step
   * is missing for however long that second step takes to arrive.
   */
  origin?: TaskOrigin;
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
      ...(input.origin ? { origin: input.origin } : {}),
    };
    await this.repository.save(task);
    this.logger.info(`Created task "${task.name}" on ${task.branchName}`);
    return ok(task);
  }

  /**
   * Makes a task for a branch that already carries work.
   *
   * The case `createTask` cannot serve: it always cuts a new branch from a base, so a
   * branch written before this extension existed, or by a chat-only task, could never
   * become one. A worktree is checked out for the branch as it stands — nothing is
   * rebased, merged or moved, because the work is the reason the branch matters.
   *
   * `baseBranch` is recorded but never acted on here. It is what later stages diff
   * against, so getting it wrong makes a review read the wrong changes — which is why
   * it is asked for rather than guessed.
   */
  async createTaskFromBranch(
    input: {
      repositoryRoot: string;
      name: string;
      branchName: string;
      baseBranch: string;
      description?: string;
      configuredParentDir: string;
    },
    signal?: AbortSignal,
  ): Promise<Result<TaskWorkspace, ServiceError>> {
    const existing = await this.repository.getByRepository(input.repositoryRoot);
    if (existing.some((t) => t.branchName === input.branchName)) {
      return err({
        kind: "validation",
        message: `A task already uses branch "${input.branchName}".`,
      });
    }

    // Same naming rules as a new task, so an adopted branch lands where every other
    // worktree does rather than somewhere only this path knows about.
    const proposal = this.proposeTask({
      repositoryRoot: input.repositoryRoot,
      name: input.name,
      branchPrefix: "",
      configuredParentDir: input.configuredParentDir,
    });
    if (!proposal.ok) return proposal;

    const created = await this.worktrees.addWorktreeForBranch(
      input.repositoryRoot,
      { branchName: input.branchName, worktreePath: proposal.value.worktreePath },
      signal,
    );
    if (!created.ok) return err({ kind: "worktree", error: created.error });

    const now = this.clock.now();
    const task: TaskWorkspace = {
      id: this.clock.newId(),
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      repositoryRoot: input.repositoryRoot,
      worktreePath: created.value.path,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.save(task);
    this.logger.info(
      `Adopted branch ${task.branchName} as task "${task.name}" at ${task.worktreePath}`,
    );
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
    // Both git calls are issued together: the ahead count does not depend on the status,
    // and running them in sequence doubled the latency of every row in the tree. A
    // missing worktree fails both, so nothing is wasted in the case the sequence was
    // guarding against.
    const [status, ahead] = await Promise.all([
      this.status.getStatus(task.worktreePath, signal),
      this.status.getCommitsAhead(task.worktreePath, task.baseBranch, signal),
    ]);
    if (!status.ok) {
      return {
        worktreeExists: false,
        isDirty: false,
        changedFileCount: 0,
        commitsAhead: 0,
      };
    }
    return {
      worktreeExists: true,
      isDirty: status.value.isDirty,
      changedFileCount: status.value.changedFileCount,
      commitsAhead: ahead.ok ? ahead.value : 0,
      currentBranch: status.value.branch,
    };
  }

  /**
   * Records — or clears — which suggestion a task is for.
   *
   * The other half of starting a task from a suggestion, and it exists because most
   * tasks do not begin that way. A task adopted from a branch, or created before a
   * source was configured, has no origin, so the ticket it is plainly for goes on being
   * offered as work nobody has picked up. That is a list you learn to distrust.
   *
   * Refuses to overwrite an existing origin: a task already linked to one ticket being
   * silently repointed at another is a change nobody could see afterwards. Clearing is
   * explicit, by passing `undefined`.
   */
  async setTaskOrigin(
    id: string,
    origin: TaskOrigin | undefined,
  ): Promise<Result<TaskWorkspace, ServiceError>> {
    const task = await this.repository.get(id);
    if (!task) return err({ kind: "notFound", message: "Task not found." });
    if (origin && task.origin) {
      return err({
        kind: "validation",
        message:
          `"${task.name}" is already linked to ${task.origin.sourceId}/${task.origin.ref}. ` +
          "Unlink it first if it is really for something else.",
      });
    }

    const updated: TaskWorkspace = {
      ...task,
      ...(origin ? { origin } : {}),
      updatedAt: this.clock.now(),
    };
    if (!origin) delete (updated as { origin?: TaskOrigin }).origin;

    await this.repository.save(updated);
    this.logger.info(
      origin
        ? `Linked task "${task.name}" to ${origin.sourceId}/${origin.ref}`
        : `Unlinked task "${task.name}" from its suggestion`,
    );
    return ok(updated);
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
