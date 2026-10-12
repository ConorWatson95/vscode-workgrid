import { decidedHeldCalls, syncHeldCalls } from "../domain/heldCalls";
import { claimAnswers, hostWork } from "../domain/hostRequests";
import { recordQuestion } from "../domain/pipelineEngine";
import { PendingQuestion } from "../domain/taskPipeline";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Logger } from "../logging/logger";
import { TaskRepository } from "../persistence/taskRepository";
import { AskUserService, PendingAsk } from "./askUserService";
import { PermissionGateService } from "./permissionGateService";

export interface LiveRequestBridgeOptions {
  repository: TaskRepository;
  askUser: AskUserService;
  permissionGate: PermissionGateService;
  logger: Logger;
  now?: () => Date;
  /**
   * Whether this process moves another process's undelivered answers into a task's
   * brief. VS Code serves every task, as it always has; a headless runner serves only
   * the task it is driving, because a brief answer may end in an advance and starting
   * other tasks is not a runner's to do.
   */
  servesBrief?: (taskId: string) => boolean;
  /** A stage's live question has been written to the state file. */
  onQuestionRecorded?: (task: TaskWorkspace) => void;
  /** Answers were delivered — back to the waiting call, or into the brief. */
  onAnswersDelivered?: (task: TaskWorkspace, delivery: { live: boolean; question: PendingQuestion }) => void;
}

/**
 * Carries live questions and held tool calls between the process running a stage and
 * every other client, through the state file.
 *
 * A stage blocked on `ask_user` or on the permission gate is waiting on a hook or an
 * MCP call inside one process — VS Code or a headless runner — and only that process
 * can release it. This writes what it is waiting on into the state file, and applies
 * the answers and decisions other clients write back. VS Code and the runner build
 * the same one (`stageRuntime.ts`), so a headless run can be asked and answered
 * exactly as one in VS Code can.
 */
export class LiveRequestBridge {
  private readonly now: () => Date;
  private readonly servesBrief: (taskId: string) => boolean;
  /** Tasks whose mirrored calls this process last wrote non-empty, so it can clear them. */
  private readonly mirrored = new Set<string>();
  private mirroring: Promise<void> = Promise.resolve();
  private serving = false;
  private again = false;
  private lastRoot: string | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LiveRequestBridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.servesBrief = options.servesBrief ?? (() => true);
  }

  /** Starts recording questions and mirroring holds; returns the stop function. */
  start(): () => void {
    const offAsked = this.options.askUser.onAsked((asked) => void this.recordQuestion(asked));
    const offChanged = this.options.permissionGate.onChanged(() => this.mirrorHolds());
    return () => {
      offAsked();
      offChanged();
      if (this.retry) clearTimeout(this.retry);
    };
  }

  /**
   * Writes a live question into the same place a `NEEDS-INFO` one goes, so every
   * client's existing question row and answer flow serve it — `liveCallId` is all
   * that tells them an agent is still waiting.
   */
  async recordQuestion(asked: PendingAsk): Promise<TaskWorkspace | undefined> {
    const { repository, askUser, logger } = this.options;
    let failure: string | undefined;
    const saved = await repository.update(asked.taskId, (task) => {
      if (!task?.pipeline) {
        failure = "the task has no route to attach it to";
        return undefined;
      }
      const running = task.pipeline.stages.find((stage) =>
        stage.subtasks.some((subtask) => subtask.status === "active"),
      );
      const subtask = running?.subtasks.find((s) => s.status === "active");
      const recorded = recordQuestion(task.pipeline, {
        stageId: running?.id ?? task.pipeline.stages[0]?.id ?? "",
        stageName: running?.name ?? "Stage",
        subtaskId: subtask?.id ?? asked.request.id,
        questions: asked.request.questions,
        context: asked.request.context,
        at: asked.waitingSince,
        liveCallId: asked.request.id,
      });
      if (!recorded.ok) {
        failure = recorded.error.message;
        return undefined;
      }
      return { ...task, pipeline: recorded.value, updatedAt: this.now().toISOString() };
    });
    if (!saved) {
      // Nothing can show it, so nobody can answer it: let the agent proceed rather
      // than block until the timeout.
      logger.error(`Could not record a live question: ${failure ?? "the task is gone"}.`);
      askUser.abandon(asked.taskId);
      return undefined;
    }
    logger.info(
      `Harness [${saved.name}] is waiting on ${asked.request.questions.length} question(s) — the agent is paused.`,
    );
    this.options.onQuestionRecorded?.(saved);
    return saved;
  }

  /**
   * Rewrites each task's mirrored calls from what the gate is holding now.
   *
   * Serialised, because the gate announces on every change and two overlapping
   * rewrites could land out of order and resurrect a call already answered.
   */
  mirrorHolds(): Promise<void> {
    this.mirroring = this.mirroring.then(() => this.mirrorOnce()).catch((error) => {
      this.options.logger.error("Harness: could not mirror held tool calls.", error);
    });
    return this.mirroring;
  }

  private async mirrorOnce(): Promise<void> {
    const waiting = this.options.permissionGate.waiting();
    const taskIds = new Set([...this.mirrored, ...waiting.map((held) => held.taskId)]);
    for (const taskId of taskIds) {
      const calls = waiting
        .filter((held) => held.taskId === taskId)
        .map((held) => ({
          id: held.request.id,
          tool: held.request.toolName,
          detail: held.detail,
          waitingSince: held.waitingSince,
        }));
      await this.options.repository.update(taskId, (task) => {
        const synced = task?.pipeline ? syncHeldCalls(task.pipeline, calls) : undefined;
        return task && synced ? { ...task, pipeline: synced } : undefined;
      });
      if (calls.length > 0) this.mirrored.add(taskId);
      else this.mirrored.delete(taskId);
    }
  }

  /**
   * Applies what other clients wrote: answers to a question this process's stage is
   * waiting on, and decisions on calls it is holding. Run whenever the state file
   * changes, which is how a request arrives.
   *
   * Every act is claimed inside `repository.update` first, so when several processes
   * watch one repository exactly one of them acts.
   */
  async serve(repositoryRoot: string): Promise<void> {
    this.lastRoot = repositoryRoot;
    if (this.serving) {
      this.again = true;
      return;
    }
    this.serving = true;
    try {
      do {
        this.again = false;
        await this.serveOnce(this.lastRoot);
      } while (this.again);
    } catch (error) {
      this.options.logger.error("Harness: could not serve a request from another client.", error);
    } finally {
      this.serving = false;
    }
  }

  private async serveOnce(repositoryRoot: string): Promise<void> {
    const { repository, askUser, permissionGate, logger } = this.options;
    const tasks = await repository.getByRepository(repositoryRoot);

    for (const task of tasks) {
      for (const call of decidedHeldCalls(task.pipeline)) {
        const decision = call.decision!;
        if (permissionGate.decide(call.id, decision.allow ? "allow" : "deny", decision.scope)) {
          logger.info(`Harness [${task.name}] applied a decision on ${call.tool} made outside this process.`);
        }
      }
    }

    const work = hostWork(tasks, this.now().getTime(), (callId) => !!askUser.get(callId));
    // A live question owned by nobody becomes deliverable only after a grace period,
    // and nothing writes the file at that moment to wake this up.
    if (this.retry) clearTimeout(this.retry);
    this.retry =
      work.retryAt === undefined
        ? undefined
        : setTimeout(
            () => void this.serve(repositoryRoot),
            Math.max(work.retryAt - this.now().getTime(), 0) + 250,
          );

    for (const action of work.actions) {
      if (action.kind === "answerBrief" && !this.servesBrief(action.taskId)) continue;
      const at = this.now().toISOString();
      const callId = action.kind === "answerLive" ? action.callId : undefined;
      let question: PendingQuestion | undefined;
      const claimed = await repository.update(action.taskId, (current) => {
        const delivered = claimAnswers(current, at, callId);
        question = delivered?.question;
        return delivered?.task;
      });
      if (!claimed || !question) continue;

      // A live question goes back to the session blocked on it, which carries on
      // mid-turn; nothing advances, because nothing stopped.
      if (callId) {
        const answers = question.items.map((item) => item.answer?.trim() ?? "");
        if (askUser.answer(callId, answers)) {
          logger.info(
            `Harness [${claimed.name}] delivered ${answers.length} answer(s) from another client; the agent is continuing.`,
          );
          this.options.onAnswersDelivered?.(claimed, { live: true, question });
          continue;
        }
        logger.warn(`Harness [${claimed.name}] the stage stopped waiting, so the answers went into the brief instead.`);
      }
      logger.info(`Harness [${claimed.name}] added ${question.items.length} answer(s) from another client to the brief.`);
      this.options.onAnswersDelivered?.(claimed, { live: false, question });
    }
  }
}
