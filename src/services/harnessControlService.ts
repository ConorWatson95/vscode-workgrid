import {
  ControlOutcome,
  ControlRefusal,
  decideApproval,
  decideChecklistItem,
  decideRetry,
} from "../domain/harnessControl";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { TaskRepository } from "../persistence/taskRepository";
import {
  RunSnapshot,
  RunSummary,
  defaultRun,
  snapshotRun,
  summariseRun,
} from "../ui/harnessSnapshot";
import { formatStageReport } from "../ui/stageReport";
import { Result, err } from "../utilities/result";

/** Injected so nothing here reads the wall clock. */
export interface ControlClock {
  now(): string;
}

/**
 * The harness, as a client that is not the extension sees it: a narrow semantic
 * surface over the one task store, with every read derived from the state file and
 * every write a decision taken inside `TaskRepository.update`.
 *
 * It holds nothing between calls. A second client that kept its own copy of a run
 * would need syncing with the first, and two copies of workflow state is exactly
 * what this exists not to create — so each call reads the file as it stands.
 *
 * It runs nothing either. Advancing a route means running stage sessions, and those
 * belong to whichever host owns the runner; this only records decisions a person
 * made, the same records the extension's commands make.
 */
export class HarnessControlService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly repositoryRoot: string,
    private readonly clock: ControlClock,
  ) {}

  private async tasks(): Promise<TaskWorkspace[]> {
    return this.repository.getByRepository(this.repositoryRoot);
  }

  /** Every routed task that is not archived, most recently touched first. */
  async listRuns(): Promise<RunSummary[]> {
    return (await this.tasks())
      .filter((task) => task.pipeline && task.status !== "archived")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summariseRun);
  }

  /** One run, or the default one when no id is given. */
  async getRun(taskId?: string): Promise<RunSnapshot | undefined> {
    const tasks = await this.tasks();
    const task = taskId ? tasks.find((t) => t.id === taskId) : defaultRun(tasks);
    return task && snapshotRun(task);
  }

  /** The stage's full report, as the extension's "Show What This Stage Did" renders it. */
  async getStageReport(taskId: string, stageId: string): Promise<string | undefined> {
    const task = (await this.tasks()).find((t) => t.id === taskId);
    const stage = task?.pipeline?.stages.find((s) => s.id === stageId);
    if (!task || !stage) return undefined;
    return formatStageReport(task.name, stage, task.pipeline, task.worktreePath);
  }

  approveStage(
    taskId: string,
    stageId: string,
    revision: string,
    note?: string,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    return this.decide(taskId, (task) => decideApproval(task, { stageId, revision, note, at }));
  }

  retryStage(
    taskId: string,
    stageId: string,
    revision: string,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    return this.decide(taskId, (task) => decideRetry(task, { stageId, revision, at }));
  }

  setChecklistItem(
    taskId: string,
    itemId: string,
    checked: boolean,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    return this.decide(taskId, (task) => decideChecklistItem(task, { itemId, checked, at }));
  }

  /**
   * Runs a decision against the task as it stands at the moment of writing.
   *
   * The decision functions are pure and refuse on a moved revision, so whatever the
   * second of two simultaneous clicks reads, it reads the first one's write.
   */
  private async decide(
    taskId: string,
    decision: (task: TaskWorkspace | undefined) => Result<ControlOutcome, ControlRefusal>,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    // Scoped to this repository: the store is per-repository already, but a task
    // seeded with a foreign root must not be writable from here either.
    const owned = (await this.tasks()).some((t) => t.id === taskId);
    if (!owned) return err({ kind: "unknownTask", message: "That task no longer exists." });

    let outcome: Result<ControlOutcome, ControlRefusal> | undefined;
    await this.repository.update(taskId, (current) => {
      outcome = decision(current);
      return outcome.ok && outcome.value.changed ? outcome.value.task : undefined;
    });
    return outcome ?? err({ kind: "unknownTask", message: "That task no longer exists." });
  }
}
