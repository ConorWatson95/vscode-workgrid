import { TaskWorkspace } from "../domain/taskWorkspace";
import { TaskPipeline } from "../domain/taskPipeline";
import {
  NextAction,
  finishSubtask,
  nextAction,
  planStage,
  recordChecklist,
  revertSubtask,
  startSubtask,
} from "../domain/pipelineEngine";
import { producesChecklist } from "../domain/taskRoute";
import {
  StageContext,
  behaviourReviewPrompt,
  parseChecklistReply,
  parseNeedsInfo,
  parseSubtaskPlan,
  splitPrompt,
  subtaskPrompt,
} from "../agents/stagePrompts";
import { TaskRepository } from "../persistence/taskRepository";
import { Logger } from "../logging/logger";
import { ReviewPlanService } from "./reviewPlanService";

/**
 * Drives a task's pipeline: asks the engine what to do next, does it, records
 * the outcome, repeats. This is the piece that turns the route from a persisted
 * description into work that actually happens.
 *
 * Two deliberate properties:
 *
 * - **Every unit of work runs in a fresh session.** That is the context lever —
 *   a subtask starts with one objective instead of inheriting a whole task's
 *   history, so context never accumulates across the route.
 * - **It stops at human gates and at failures**, rather than pushing through.
 *   The route is a chain of preconditions; a runner that stepped over a red
 *   stage would make every later stage meaningless.
 */

/** One prompt, run to completion in a fresh session. */
export interface StageSessionRunner {
  run(
    task: TaskWorkspace,
    prompt: string,
    label: string,
  ): Promise<{ ok: boolean; text: string; sessionId?: string; error?: string }>;
}

export type RunOutcome =
  /** Stopped at a human gate; the stage id is awaiting approval. */
  | { kind: "awaitingApproval"; stageId: string; stageName: string }
  /** A stage failed. Nothing further was attempted. */
  | { kind: "blocked"; stageId: string; stageName: string; reason?: string }
  /** A stage needs information the brief does not contain. */
  | {
      kind: "needsInput";
      stageId: string;
      stageName: string;
      subtaskId: string;
      question: string;
    }
  /** The route finished. */
  | { kind: "done" }
  /** Hit the step limit — a safety net, not an expected outcome. */
  | { kind: "exhausted"; steps: number }
  /** The task has no pipeline to drive. */
  | { kind: "unharnessed" }
  /** Cancelled by the caller. */
  | { kind: "cancelled" };

export interface RunReport {
  outcome: RunOutcome;
  /** Human-readable log of what the runner did, in order. */
  steps: string[];
}

/**
 * Upper bound on transitions per invocation. Guards against a rule set or split
 * that somehow cycles; a real route is well under ten steps.
 */
const MAX_STEPS = 40;

export class PipelineRunner {
  constructor(
    private readonly sessions: StageSessionRunner,
    private readonly repository: TaskRepository,
    private readonly reviewPlans: ReviewPlanService,
    private readonly logger: Logger,
  ) {}

  /** In-flight routes, so stopping a task's agent can stop its route too. */
  private readonly running = new Map<string, AbortController>();

  /**
   * Subtasks *this* runner started. A persisted `running` subtask missing from
   * here was left behind by a previous extension host, which cannot still be
   * working on it — see `reclaimStale`.
   */
  private readonly startedSubtasks = new Set<string>();

  /**
   * Stops a route mid-flight. Called when the user stops the task's agent:
   * killing the session alone would only end the current subtask, and the driver
   * would immediately start the next one.
   *
   * The interrupted subtask is reverted to pending rather than recorded as done
   * or failed, so the route resumes from it rather than skipping past it.
   */
  cancel(taskId: string): void {
    const controller = this.running.get(taskId);
    if (!controller) return;
    this.logger.info(`Harness: stopping the route for task ${taskId}.`);
    controller.abort();
  }

  /** Whether a route is currently being driven for this task. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /**
   * Advances the pipeline as far as it can go unattended. Returns when a human
   * is needed, something fails, or the route completes.
   */
  async advance(
    task: TaskWorkspace,
    signal?: AbortSignal,
  ): Promise<RunReport> {
    if (!task.pipeline) return { outcome: { kind: "unharnessed" }, steps: [] };

    // One controller per task, so `cancel` can reach a route the caller started
    // without holding the caller's own signal.
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const previous = this.running.get(task.id);
    this.running.set(task.id, controller);
    try {
      return await this.drive(task, controller.signal);
    } finally {
      if (this.running.get(task.id) === controller) this.running.delete(task.id);
      else if (previous) this.running.set(task.id, previous);
    }
  }

  private async drive(
    task: TaskWorkspace,
    signal?: AbortSignal,
  ): Promise<RunReport> {

    const steps: string[] = [];
    let current = task;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) return { outcome: { kind: "cancelled" }, steps };

      // Re-evaluate review rules each time round: the diff grows as stages run,
      // and applyRules is idempotent, so a newly-touched .sql file adds its
      // review before the human gate even if the route began without one.
      const applied = await this.reviewPlans.apply(current, signal);
      if (applied.ok && applied.value.added.length > 0) {
        steps.push(
          `Rules added ${applied.value.added.map((s) => s.name).join(", ")}.`,
        );
        current = (await this.repository.get(current.id)) ?? current;
      }

      const pipeline = current.pipeline;
      if (!pipeline) return { outcome: { kind: "unharnessed" }, steps };

      const action = nextAction(pipeline);
      switch (action.kind) {
        case "done":
          return { outcome: { kind: "done" }, steps };

        case "awaitApproval":
          steps.push(`Stopped for approval at "${action.stage.name}".`);
          return {
            outcome: {
              kind: "awaitingApproval",
              stageId: action.stage.id,
              stageName: action.stage.name,
            },
            steps,
          };

        case "blocked":
          steps.push(`Blocked at "${action.stage.name}".`);
          return {
            outcome: {
              kind: "blocked",
              stageId: action.stage.id,
              stageName: action.stage.name,
              reason: action.stage.subtasks.find((s) => s.failureReason)?.failureReason,
            },
            steps,
          };

        case "running": {
          // A subtask this runner never started cannot still be in flight: agent
          // sessions die with the extension host, so the flag was left behind by
          // a host that was closed mid-subtask. Reclaim it rather than blocking
          // the route forever — there is no other way back from that state.
          if (!this.startedSubtasks.has(action.subtask.id)) {
            const reclaimed = revertSubtask(pipeline, action.subtask.id);
            if (reclaimed.ok) {
              current = await this.save(current, reclaimed.value);
              steps.push(
                `Reclaimed "${action.subtask.title}", left running by a closed session.`,
              );
              continue;
            }
          }
          // Otherwise a concurrent advance for this task really is running it.
          steps.push(`"${action.subtask.title}" is already running.`);
          return {
            outcome: { kind: "blocked", stageId: action.stage.id, stageName: action.stage.name, reason: "a subtask is already in flight" },
            steps,
          };
        }

        case "split": {
          const result = await this.doSplit(current, action, steps);
          if (!result) {
            return {
              outcome: {
                kind: "blocked",
                stageId: action.stage.id,
                stageName: action.stage.name,
                reason: "planning the stage failed",
              },
              steps,
            };
          }
          current = result;
          break;
        }

        case "run": {
          const result = await this.doRun(current, action, steps, signal);
          current = result.task;
          // Stopped mid-subtask: report it as cancelled here rather than letting
          // the next iteration's abort check do it, so the reverted subtask is
          // already saved and the route is resumable.
          if (result.cancelled) return { outcome: { kind: "cancelled" }, steps };
          // The stage asked a question instead of working. Nothing was attempted,
          // so the subtask is back in the queue and the route pauses.
          if (result.question) {
            return {
              outcome: {
                kind: "needsInput",
                stageId: action.stage.id,
                stageName: action.stage.name,
                subtaskId: action.subtask.id,
                question: result.question,
              },
              steps,
            };
          }
          // The engine only fails a stage once every subtask has resolved, which
          // is right for judging the stage but wrong for deciding whether to keep
          // spending sessions. Siblings are told to be independent, but a failure
          // usually means the plan was wrong — so stop and let a human look.
          if (result.failed) {
            return {
              outcome: {
                kind: "blocked",
                stageId: action.stage.id,
                stageName: action.stage.name,
                reason: result.reason,
              },
              steps,
            };
          }
          break;
        }
      }
    }

    return { outcome: { kind: "exhausted", steps: MAX_STEPS }, steps };
  }

  /** Runs the planning agent for a splittable stage and records the subtasks. */
  private async doSplit(
    task: TaskWorkspace,
    action: Extract<NextAction, { kind: "split" }>,
    steps: string[],
  ): Promise<TaskWorkspace | undefined> {
    const reply = await this.sessions.run(
      task,
      splitPrompt(contextFor(task), action.stage),
      `plan:${action.stage.id}`,
    );
    if (!reply.ok) {
      this.logger.error(
        `Planning "${action.stage.name}" failed: ${reply.error ?? "unknown error"}`,
      );
      return undefined;
    }

    const specs = parseSubtaskPlan(reply.text);
    if (specs.length === 0) {
      // An unparseable plan is not a stage failure — fall back to running the
      // stage as a single unit rather than stalling the whole route.
      this.logger.warn(
        `Planning "${action.stage.name}" produced no parseable subtasks; running it as one unit.`,
      );
      steps.push(`Could not parse a plan for "${action.stage.name}"; running it whole.`);
    } else {
      steps.push(
        `Split "${action.stage.name}" into ${specs.length}: ${specs.map((s) => s.title).join("; ")}.`,
      );
    }

    const planned = planStage(
      task.pipeline!,
      action.stage.id,
      specs.length > 0
        ? specs
        : [{ title: action.stage.name, prompt: action.stage.intent }],
    );
    if (!planned.ok) {
      // Returning the pipeline unchanged would make nextAction ask to split again
      // on the next iteration, spinning until the step limit. Treat it as a stop.
      this.logger.error(
        `Could not record a plan for "${action.stage.name}": ${planned.error.message}`,
      );
      return undefined;
    }
    return this.save(task, planned.value);
  }

  /** Runs one subtask in a fresh session and records its outcome. */
  private async doRun(
    task: TaskWorkspace,
    action: Extract<NextAction, { kind: "run" }>,
    steps: string[],
    signal?: AbortSignal,
  ): Promise<{
    task: TaskWorkspace;
    failed: boolean;
    reason?: string;
    question?: string;
    cancelled?: boolean;
  }> {
    const { stage, subtask } = action;
    const context = contextFor(task);

    // A behaviour review is asked for a checklist; everything else does the work.
    const prompt = producesChecklist(stage.kind)
      ? behaviourReviewPrompt(context, stage)
      : subtaskPrompt(context, stage, subtask);

    let pipeline = task.pipeline!;
    const started = startSubtask(pipeline, subtask.id, {
      at: new Date().toISOString(),
    });
    if (started.ok) {
      pipeline = started.value;
      this.startedSubtasks.add(subtask.id);
      task = await this.save(task, pipeline);
    }

    const reply = await this.sessions.run(task, prompt, `${stage.id}:${subtask.id}`);

    // A stop is not an outcome. Stopping the agent kills the session, which looks
    // exactly like a completed turn from here — recording it as done would pass a
    // stage nobody finished. Revert so the route resumes from this subtask.
    if (signal?.aborted) {
      const reverted = revertSubtask(pipeline, subtask.id);
      if (reverted.ok) pipeline = reverted.value;
      steps.push(`"${subtask.title}" was stopped; it will run again.`);
      return { task: await this.save(task, pipeline), failed: false, cancelled: true };
    }

    // A question takes precedence over every other reading of the reply: the work
    // was not done, so it must not be recorded as done or failed.
    const question = reply.ok ? parseNeedsInfo(reply.text) : undefined;
    if (question) {
      const reverted = revertSubtask(pipeline, subtask.id);
      if (reverted.ok) pipeline = reverted.value;
      steps.push(`"${subtask.title}" asked for more information.`);
      return { task: await this.save(task, pipeline), failed: false, question };
    }

    if (reply.ok && producesChecklist(stage.kind)) {
      const items = parseChecklistReply(reply.text);
      const recorded = recordChecklist(pipeline, stage.id, items);
      if (recorded.ok) pipeline = recorded.value;
      steps.push(
        items.length > 0
          ? `"${stage.name}" raised ${items.length} verification item(s).`
          : `"${stage.name}" found nothing needing manual verification.`,
      );
    } else if (reply.ok) {
      steps.push(`Completed "${subtask.title}".`);
    } else {
      steps.push(`"${subtask.title}" failed: ${reply.error ?? "unknown error"}`);
    }

    const reason = reply.ok ? undefined : (reply.error ?? "the agent session failed");
    const finished = finishSubtask(pipeline, subtask.id, {
      status: reply.ok ? "done" : "failed",
      at: new Date().toISOString(),
      reason,
    });
    if (finished.ok) pipeline = finished.value;

    return {
      task: await this.save(task, pipeline),
      failed: !reply.ok,
      reason,
    };
  }

  private async save(
    task: TaskWorkspace,
    pipeline: TaskPipeline,
  ): Promise<TaskWorkspace> {
    const updated = {
      ...task,
      pipeline,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.save(updated);
    return updated;
  }
}

function contextFor(task: TaskWorkspace): StageContext {
  return {
    taskName: task.name,
    taskDescription: task.description,
    branchName: task.branchName,
    baseBranch: task.baseBranch,
  };
}
