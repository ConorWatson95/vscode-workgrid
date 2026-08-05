import { TaskWorkspace } from "../domain/taskWorkspace";
import { SubtaskActivity, TaskPipeline, TaskStage } from "../domain/taskPipeline";
import {
  resolveStageModel,
  StageModelSource,
} from "../domain/stageModelResolution";
import {
  NextAction,
  finishSubtask,
  nextAction,
  planStage,
  recordChecklist,
  recordDenials,
  recordQuestion,
  recordHandoff,
  handoffsBefore,
  holdStageForFindings,
  recordStageVerdict,
  revertSubtask,
  startSubtask,
} from "../domain/pipelineEngine";
import { producesChecklist, StageKind } from "../domain/taskRoute";
import { BranchMismatch, branchMismatch } from "../domain/branchGuard";
import {
  hasBlockingFindings,
  parseReviewFindings,
  summariseFindings,
} from "../domain/reviewFindings";

import {
  StageContext,
  behaviourReviewPrompt,
  parseChecklistReply,
  parseNeedsInfo,
  parseSubtaskPlan,
  splitPrompt,
  subtaskPrompt,
  parseVerdict,
  stripVerdict,
} from "../agents/stagePrompts";
import { TaskRepository } from "../persistence/taskRepository";
import { Logger } from "../logging/logger";
import { ReviewPlanService } from "./reviewPlanService";
import {
  PermissionDenial,
  formatDenialReport,
  suggestAllowRules,
} from "../agents/permissionDenials";

/**
 * Stage kinds whose reply is a verdict about work someone else did.
 *
 * A behaviour review is excluded on purpose: it is a QA *planner*, not a judge —
 * its output is a checklist for a human, so "findings" there are the deliverable
 * rather than a reason to stop.
 */
const REVIEW_KINDS = new Set<StageKind>(["codeReview", "domainReview"]);

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
    /** Per-stage overrides; absent fields fall back to the configured defaults. */
    options?: {
      model?: string;
      /** Called the instant a tool call is refused, while the stage still runs. */
      onDenial?: (denial: PermissionDenial) => void;
      /**
       * Called as the run works, with everything it has done so far. Throttled by
       * the implementation — this fires per tool call, and a stage makes many.
       */
      onActivity?: (activity: SubtaskActivity) => void;
    },
  ): Promise<{
    ok: boolean;
    text: string;
    sessionId?: string;
    error?: string;
    /** Tool calls the permission layer refused during this run. */
    denials?: PermissionDenial[];
    /** What the run actually did, for the stage report. */
    activity?: SubtaskActivity;
  }>;
}

/** A subtask's work in progress: which one, and what it has done so far. */
export interface LiveActivity {
  stageId: string;
  subtaskId: string;
  activity: SubtaskActivity;
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
      /** One entry per question; each is answered separately. */
      questions: string[];
    }
  /** The route finished. */
  | { kind: "done" }
  /** Hit the step limit — a safety net, not an expected outcome. */
  | { kind: "exhausted"; steps: number }
  /** The task has no pipeline to drive. */
  | { kind: "unharnessed" }
  /**
   * A tool call was refused, so the stage could not do its job properly.
   * The subtask is back to pending: grant the permission and advance again.
   */
  | {
      kind: "denied";
      stageId: string;
      stageName: string;
      subtaskId: string;
      denials: PermissionDenial[];
    }
  /** Cancelled by the caller. */
  | { kind: "cancelled" };

export interface RunReport {
  outcome: RunOutcome;
  /** Human-readable log of what the runner did, in order. */
  steps: string[];
  /**
   * Tool calls the permission layer refused during this advance.
   *
   * Reported separately from the outcome because a refusal rarely fails the
   * stage — the agent works around it — so it would otherwise never reach the
   * user, who is the only one who can grant the permission.
   */
  denials: PermissionDenial[];
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
    /**
     * Where the project documents itself, named to every stage. A function
     * because it is a setting the user can change between advances.
     */
    private readonly docsPath: () => string | undefined = () => undefined,
    /** Called the instant a tool call is refused, so the user can act at once. */
    private readonly onDenial: (
      task: TaskWorkspace,
      denial: PermissionDenial,
    ) => void = () => {},
    /**
     * Whether a refusal stops the route. On by default: a stage that could not
     * run a command it judged necessary has not done its job, and continuing
     * buries that behind whatever it did instead.
     */
    private readonly pauseOnDenial: () => boolean = () => true,
    /**
     * Current project config, read afresh so a stage's model reflects the file
     * rather than the copy taken when the task was created. See
     * `resolveStageModel` for why model is the one stage field not snapshotted.
     */
    private readonly stageModelSource: () => StageModelSource | undefined = () =>
      undefined,
    /**
     * The branch a worktree is currently on, or undefined if it cannot be read.
     *
     * Injected and optional, so the runner's tests need no git and a headless run
     * without it behaves exactly as before.
     */
    private readonly currentBranch?: (
      worktreePath: string,
    ) => Promise<string | undefined>,
  ) {}

  /**
   * Whether the worktree is on the task's branch, for a stage that requires it.
   *
   * Per stage, not per advance: a promotion stage may legitimately need to move the
   * worktree — a UAT promotion goes through a PR — so the question is not "is this
   * the right branch" but "does *this* stage depend on being on it". A review does;
   * a deployment that promotes does not.
   *
   * Undefined when no branch source is injected, so the runner's tests need no git
   * and a headless run without one behaves exactly as before.
   */
  private async branchState(
    task: TaskWorkspace,
  ): Promise<BranchMismatch | undefined> {
    const source = this.currentBranch;
    if (!source) return undefined;
    const actual = await source(task.worktreePath);
    // A git failure is not a mismatch: refusing to run because a call returned
    // nothing would strand the task for a reason the message could not explain.
    return actual ? branchMismatch(task.intendedBranch, actual) : undefined;
  }

  /** The model a stage should run on now, not when the task was created. */
  private modelFor(task: TaskWorkspace, stage: TaskStage): string | undefined {
    const source = this.stageModelSource();
    if (!source) return stage.model;
    return resolveStageModel(source, task.pipeline?.routeId ?? "", stage);
  }

  /**
   * Permission refusals seen during the current advance, so the caller can show
   * one summary rather than a warning per subtask.
   */
  private denied: PermissionDenial[] = [];

  /** In-flight routes, so stopping a task's agent can stop its route too. */
  private readonly running = new Map<string, AbortController>();

  /**
   * Tasks already told their worktree has moved, so the driver's loop says it once
   * rather than on each of its iterations.
   */
  private readonly warnedBranch = new Set<string>();

  /**
   * What the currently running subtask has done so far, by task id.
   *
   * Held in memory rather than persisted: a subtask's activity only reaches the
   * state file when it finishes, and writing it per tool call would rewrite the
   * whole file dozens of times a stage. This is what lets a report opened on a
   * running stage show the commands as they happen instead of staying empty until
   * the stage ends.
   */
  private readonly liveActivities = new Map<string, LiveActivity>();

  /** The in-progress activity for a task, if a subtask of it is running now. */
  liveActivity(taskId: string): LiveActivity | undefined {
    return this.liveActivities.get(taskId);
  }

  /** What every stage is told about the task it is working on. */
  private contextFor(task: TaskWorkspace, stageId?: string): StageContext {
    return {
      taskName: task.name,
      taskDescription: task.description,
      branchName: task.branchName,
      baseBranch: task.baseBranch,
      docsPath: this.docsPath() || undefined,
      // Every later stage sees it: guidance given at a gate is about the work that
      // follows, so expiring it at the next stage boundary would waste it.
      guidance: (task.pipeline?.guidance ?? []).map((note) => note.text),
      handoffs: stageId ? handoffsBefore(task.pipeline!, stageId) : undefined,
    };
  }

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
    if (!task.pipeline) {
      return { outcome: { kind: "unharnessed" }, steps: [], denials: [] };
    }

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
      // Denials are attached here rather than at each of the driver's dozen
      // return points: they are a property of the whole advance, not of whichever
      // outcome ended it.
      const report = await this.drive(task, controller.signal);
      return { ...report, denials: this.denied };
    } finally {
      if (this.running.get(task.id) === controller) this.running.delete(task.id);
      else if (previous) this.running.set(task.id, previous);
    }
  }

  private async drive(
    task: TaskWorkspace,
    signal?: AbortSignal,
  ): Promise<Omit<RunReport, "denials">> {

    const steps: string[] = [];
    // Per-advance, so a summary reflects this run rather than accumulating.
    this.denied = [];
    let current = task;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) return { outcome: { kind: "cancelled" }, steps };

      // One git call per iteration, shared by the two things that depend on it.
      const moved = await this.branchState(current);

      // Re-evaluate review rules each time round: the diff grows as stages run,
      // and applyRules is idempotent, so a newly-touched .sql file adds its
      // review before the human gate even if the route began without one.
      //
      // Skipped entirely while the worktree is on another branch, because the
      // changed-path set is then a diff of two lineages rather than of this task's
      // work. Measured on a real task: 9,569 changed paths instead of a handful,
      // which matched every rule in the project's file — a tooling review, a
      // resource-culture review and an ETL review all queued onto a task that had
      // touched one stored procedure.
      if (moved) {
        if (!this.warnedBranch.has(current.id)) {
          this.warnedBranch.add(current.id);
          this.logger.warn(
            `Harness [${current.name}] not evaluating review rules: the worktree is on ` +
              `"${moved.actual}", so the changed-file set is a diff against a different ` +
              `branch entirely and would match rules this task's work never touched.`,
          );
          steps.push(
            `Skipped review rules: the worktree is on "${moved.actual}", not "${moved.intended}".`,
          );
        }
      }
      const applied = moved
        ? undefined
        : await this.reviewPlans.apply(current, signal);
      // In the step list as well as the log: this is the difference between "no
      // reviews were required" and "we could not tell what was required", and the
      // two read identically when only the outcome is reported.
      if (applied?.ok && applied.value.implausible) {
        steps.push(
          `Review rules not applied: ${applied.value.implausible.count} changed paths ` +
            `is a branch-lineage diff, not this task's work.`,
        );
      }
      if (applied?.ok && applied.value.declined) {
        steps.push(
          `Declined ${applied.value.declined.length} rule-added review(s): ` +
            `${applied.value.declined.map((s) => s.name).join(", ")}.`,
        );
      }
      if (applied?.ok && applied.value.added.length > 0) {
        steps.push(
          `Rules added ${applied.value.added.map((s) => s.name).join(", ")}.`,
        );
        current = (await this.repository.get(current.id)) ?? current;
      }

      const pipeline = current.pipeline;
      if (!pipeline) return { outcome: { kind: "unharnessed" }, steps };

      const action = nextAction(pipeline);

      // Ahead of the dispatch, so it covers splitting as well as running: both start
      // an agent session in the worktree, and a planning session that reads the wrong
      // tree produces a plan for work that is not there. Keyed on the stage about to
      // act, because a promotion stage may legitimately have moved the worktree —
      // a UAT promotion goes through a PR.
      if ((action.kind === "split" || action.kind === "run") && !action.stage.mayChangeBranch) {
        const mismatch = moved;
        if (mismatch) {
          this.logger.error(
            `Harness [${current.name}] "${action.stage.name}" not run. ${mismatch.message}`,
          );
          steps.push(
            `"${action.stage.name}" was not run: the worktree is on ` +
              `"${mismatch.actual}", not "${mismatch.intended}".`,
          );
          return {
            outcome: {
              kind: "blocked",
              stageId: action.stage.id,
              stageName: action.stage.name,
              reason: mismatch.message,
            },
            steps,
          };
        }
      }

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
          if (result.denied) {
            return {
              outcome: {
                kind: "denied",
                stageId: action.stage.id,
                stageName: action.stage.name,
                subtaskId: action.subtask.id,
                denials: result.denied,
              },
              steps,
            };
          }
          // The stage asked a question instead of working. Nothing was attempted,
          // so the subtask is back in the queue and the route pauses.
          if (result.question) {
            return {
              outcome: {
                kind: "needsInput",
                stageId: action.stage.id,
                stageName: action.stage.name,
                subtaskId: action.subtask.id,
                questions: result.question,
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
      splitPrompt(this.contextFor(task, action.stage.id), action.stage),
      `plan:${action.stage.id}`,
      { model: this.modelFor(task, action.stage) },
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
    question?: string[];
    cancelled?: boolean;
    denied?: PermissionDenial[];
  }> {
    const { stage, subtask } = action;

    const context = this.contextFor(task, stage.id);

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

    const taskId = task.id;
    let reply;
    try {
      reply = await this.sessions.run(task, prompt, `${stage.id}:${subtask.id}`, {
        model: this.modelFor(task, stage),
        onDenial: (denial) => this.onDenial(task, denial),
        onActivity: (activity) =>
          this.liveActivities.set(taskId, {
            stageId: stage.id,
            subtaskId: subtask.id,
            activity,
          }),
      });
    } finally {
      // The finished activity is on the subtask from here on, and a live copy that
      // outlived its run would keep overriding it in the report.
      this.liveActivities.delete(taskId);
    }

    // Read before the marker is removed, and removed before anything keeps the
    // reply: it is a protocol line between the harness and the agent, and it was
    // reaching the report, the handoff and every later stage's prompt verbatim.
    const verdict = parseVerdict(reply.text);
    reply = { ...reply, text: stripVerdict(reply.text) };

    // Surface refusals whatever the outcome. A denied tool call is otherwise
    // silent: the agent rewords it, retries, eventually works around it or asks
    // a question that reads like a briefing problem, and nothing anywhere says a
    // permission was the cause.
    const denials = reply.denials ?? [];
    if (denials.length > 0) {
      this.denied.push(...denials);
      this.logger.warn(
        `Harness [${task.name}] ${stage.name}: ${formatDenialReport(denials)}`,
      );
      const attempts = denials.reduce((total, d) => total + d.attempts, 0);
      steps.push(
        `${denials.length} tool call(s) denied by permissions` +
          (attempts > denials.length ? ` over ${attempts} attempts` : "") +
          " — the log lists the allow rules to add.",
      );

      if (this.pauseOnDenial()) {
        // Revert rather than record an outcome: the stage worked around a tool it
        // wanted, so neither "done" nor "failed" is true. Granting the permission
        // and advancing re-runs this subtask with it available.
        const reverted = revertSubtask(pipeline, subtask.id);
        if (reverted.ok) pipeline = reverted.value;

        // Persist them with the task. A notification is transient and several
        // tasks make a pile of them, so dismissing one used to lose the only
        // record of what was refused and which rule would fix it.
        const recorded = recordDenials(pipeline, {
          stageId: stage.id,
          stageName: stage.name,
          subtaskId: subtask.id,
          items: denials.map((denial) => ({
            tool: denial.tool,
            command: denial.command,
            reason: denial.reason,
            attempts: denial.attempts,
            rule: suggestAllowRules([denial], {
              worktreePath: task.worktreePath,
              repositoryRoot: task.repositoryRoot,
            })[0],
          })),
          at: new Date().toISOString(),
        });
        if (recorded.ok) pipeline = recorded.value;

        return {
          task: await this.save(task, pipeline),
          failed: false,
          denied: denials,
        };
      }
    }

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
      // Persist the question with the task. The session that asked it is gone,
      // so anything not stored here is unrecoverable — dismissing a dialog used
      // to mean re-running the stage just to find out what it wanted.
      const recorded = recordQuestion(pipeline, {
        stageId: stage.id,
        stageName: stage.name,
        subtaskId: subtask.id,
        questions: question,
        at: new Date().toISOString(),
      });
      if (recorded.ok) pipeline = recorded.value;
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
      // Kept so the stage is not invisible afterwards. On failure especially: a
      // stage that went wrong is the one you most want to be able to read.
      reply: reply.text,
      activity: reply.activity,
    });
    if (finished.ok) pipeline = finished.value;

    // A review that found something must not pass as though it had not. This is the
    // one place a stage outcome stops being purely self-reported: the reply is read
    // for findings, and a critical or important one holds the stage for a human
    // rather than letting the route deploy over it.
    if (reply.ok && REVIEW_KINDS.has(stage.kind)) {
      const findings = parseReviewFindings(reply.text);
      // Recorded whichever way it went, so the report can say the review passed it
      // rather than leaving the reader to infer that from an absence.
      if (verdict) {
        const noted = recordStageVerdict(pipeline, stage.id, verdict);
        if (noted.ok) pipeline = noted.value;
      }
      // The reviewer's own verdict wins where it gave one. Reading severities out of
      // prose is a fallback for a review that did not state one, not the primary
      // signal: the same inference read a report with one blocker and a long
      // "everything else is fine" section as fourteen blockers, and a route that
      // stops for nothing teaches you to click past the stop.
      // The verdict captured above, not re-read here: the marker has been stripped
      // out of the reply by this point, so re-parsing would find nothing and fall
      // back to the prose inference this exists to override.
      const blocking = verdict ? verdict === "block" : hasBlockingFindings(findings);
      if (blocking) {
        const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
        if (held.ok) {
          pipeline = held.value;
          const summary = summariseFindings(findings) ?? "findings";
          steps.push(`"${stage.name}" found ${summary} — held for you.`);
          this.logger.warn(
            `Harness [${task.name}] ${stage.name} found ${summary}; holding the route. ` +
              "Approve to accept them, or send the findings back to an earlier stage.",
          );
        }
      }
    }

    // Recorded only on success, and only for stages the route marks `handoff`. A
    // failed stage's conclusion is not a conclusion, and carrying it forward would
    // present a guess to every stage after it as established fact.
    if (reply.ok && reply.text.trim()) {
      pipeline = recordHandoff(
        pipeline,
        stage.id,
        reply.text,
        new Date().toISOString(),
      );
    }

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


