import {
  ControlOutcome,
  ControlRefusal,
  SendBackRequest,
  decideAnswers,
  decideApproval,
  decideChecklistItem,
  decideCorrection,
  decideRerun,
  decideRetry,
  decideSendBack,
  sessionInFlight,
} from "../domain/harnessControl";
import { requestStop } from "../domain/runLease";
import { StageDefinitionSource } from "../domain/stageRefresh";
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
import { Result, err, ok } from "../utilities/result";

/**
 * Starts a route advancing in a process of its own (`mcp/runLauncher.ts`).
 *
 * Injected because starting a runner is a process spawn, and everything else here
 * is a decision against the state file that tests can run without one.
 */
export interface RunControl {
  /** Resolves once the runner holds the task, or with why it did not. */
  start(taskId: string): Promise<{ ok: boolean; message: string }>;
}

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
 * It runs nothing itself. Advancing a route means running stage sessions for many
 * minutes, which a one-shot call cannot host, so `advance` hands it to a headless
 * runner through `RunControl` and returns once that runner has taken the task.
 */
export class HarnessControlService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly repositoryRoot: string,
    private readonly clock: ControlClock,
    /**
     * The project's routes and rules, read when a decision re-opens stages so they
     * run with current instructions. Absent means they keep what they had.
     */
    private readonly definitions?: () => StageDefinitionSource,
    /** Absent means this client cannot start runs, and says so when asked to. */
    private readonly runs?: RunControl,
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

  /**
   * The board and every run on it, from one read of the store.
   *
   * A pane that keeps every run to hand would otherwise call `getRun` once per
   * task, and each call parses the whole state file — 24 runs over a 16MB file is
   * 24 parses for one change.
   */
  async readBoard(): Promise<{ runs: RunSummary[]; snapshots: RunSnapshot[] }> {
    const tasks = (await this.tasks())
      .filter((task) => task.pipeline && task.status !== "archived")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { runs: tasks.map(summariseRun), snapshots: tasks.map(snapshotRun) };
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

  correctStage(
    taskId: string,
    stageId: string,
    revision: string,
    finding: string,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    return this.decide(taskId, (task) => decideCorrection(task, { stageId, revision, finding, at }));
  }

  rerunStage(
    taskId: string,
    stageId: string,
    revision: string,
    reason?: string,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    const definitions = this.definitions?.();
    return this.decide(taskId, (task) =>
      decideRerun(task, { stageId, revision, reason, at, definitions }),
    );
  }

  sendBack(
    taskId: string,
    request: Omit<SendBackRequest, "at" | "definitions">,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    const definitions = this.definitions?.();
    return this.decide(taskId, (task) => decideSendBack(task, { ...request, at, definitions }));
  }

  answerQuestions(
    taskId: string,
    askedAt: string,
    answers: Record<string, string>,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    return this.decide(taskId, (task) => decideAnswers(task, { askedAt, answers, at }));
  }

  /**
   * Starts the route advancing in a headless runner.
   *
   * Refused while a stage is running, which is the one state where a second runner is
   * certainly wrong. A run lease is not checked here: the runner checks it itself,
   * with the OS's word on whether the holder is still alive, and reports why it
   * declined.
   */
  async advance(taskId: string): Promise<Result<ControlOutcome, ControlRefusal>> {
    const task = await this.repository.get(taskId);
    if (!task) return err({ kind: "unknownTask", message: "That task no longer exists." });
    if (!task.pipeline) {
      return err({ kind: "noPipeline", message: `"${task.name}" has no route attached.` });
    }
    const running = sessionInFlight(task.pipeline);
    if (running) {
      return err({ kind: "inFlight", message: `"${running.name}" is already running.` });
    }
    if (!this.runs) {
      return err({ kind: "refused", message: "This client cannot start runs." });
    }
    const started = await this.runs.start(taskId);
    if (!started.ok) return err({ kind: "refused", message: started.message });
    return ok({ task: (await this.repository.get(taskId)) ?? task, changed: true, message: started.message });
  }

  /** Asks whichever process is advancing the route to stop it. */
  stop(taskId: string): Promise<Result<ControlOutcome, ControlRefusal>> {
    const at = this.clock.now();
    return this.decide(taskId, (task) => {
      if (!task) return err({ kind: "unknownTask", message: "That task no longer exists." });
      if (task.pipeline?.stopRequestedAt) {
        return ok({ task, changed: false, message: "Already asked to stop." });
      }
      const stopping = requestStop(task, at);
      return stopping
        ? ok({ task: stopping, changed: true, message: "Asked the run to stop. It stops at the current step." })
        : err({ kind: "refused", message: `"${task.name}" is not advancing.` });
    });
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
