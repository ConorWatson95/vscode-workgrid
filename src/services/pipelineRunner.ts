import { certifyStage } from "../domain/stageAuthority";
import { adjudicateRepair, parseRepairProposals } from "../domain/repairProposal";
import {
  adjudicateInsert,
  adjudicateReverify,
  parseInsertProposals,
  parseReverifyProposals,
} from "../domain/routeMutation";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Subtask, SubtaskActivity, TaskPipeline, TaskStage } from "../domain/taskPipeline";
import {
  resolveAmendmentModel,
  resolveStageModel,
  StageModelSource,
} from "../domain/stageModelResolution";
import {
  NextAction,
  finishSubtask,
  narrowAmendments,
  nextAction,
  approveStage,
  correctStage,
  insertStage,
  ruleInsertionIndex,
  planStage,
  recordAssessments,
  recordChecklist,
  recordDenials,
  recordQuestion,
  recordHandoff,
  recordDeferrals,
  recordActions,
  recordPlanSteps,
  recordStepAccounts,
  unaccountedPlanSteps,
  recordStageBlocked,
  handoffsBefore,
  holdStageForFindings,
  recordStageVerdict,
  recordVerification,
  revertSubtask,
  startSubtask,
} from "../domain/pipelineEngine";
import { formatSendBackNote, guidanceFor } from "../domain/stageRefresh";
import { withHumanWait } from "../domain/humanWait";
import { declaredScopes } from "../domain/checklistScope";
import {
  CHANGED_NOTHING_REASON,
  CORRECTION_CHANGED_NOTHING_REASON,
  changedNothing,
  correctionChangedNothing,
} from "../domain/stageProductivity";
import {
  MISSING_PULL_REQUEST_REASON,
  missingPullRequestUrl,
} from "../domain/pullRequestEvidence";
import { producesChecklist, StageKind } from "../domain/taskRoute";
import { handoffsSuppressed } from "../domain/pipelineExperiment";
import { BranchMismatch, branchMismatch } from "../domain/branchGuard";
import { redactSecrets } from "../domain/secretRedaction";
import { summariseIntent } from "../domain/routeSummary";
import { substitutePlaceholders } from "../domain/commandPlaceholders";
import { taskTicket } from "../domain/ticketReference";
import { describeDiscard, DiscardSelection } from "../domain/worktreeDiscard";
import {
  backoffMs,
  DEFAULT_TRANSIENT_ATTEMPTS,
  isTransientFailure,
} from "../domain/transientFailure";
import {
  CommandOutcome,
  VerificationCommandRunner,
  describeVerification,
} from "./verificationRunner";
import {
  hasBlockingFindings,
  parseReviewFindings,
  summariseFindings,
} from "../domain/reviewFindings";

import {
  StageContext,
  assessmentPrompt,
  correctionPrompt,
  behaviourReviewPrompt,
  parseAssessments,
  parseChecklistReply,
  parseNeedsInfo,
  readStageReply,
  parseSubtaskPlan,
  splitPrompt,
  subtaskPrompt,
} from "../agents/stagePrompts";
import { PlanStep, parsePlanSteps } from "../domain/planSteps";
import { parsePlanQuestions, planQuestionsReason } from "../domain/planQuestions";
import { discoveredDocuments, discoveredNote } from "../domain/discoveredDocuments";
import { addDiscoveredReferences } from "../domain/taskReferences";
import {
  describeStaleSubtask,
  StaleSubtask,
  staleActiveSubtasks,
} from "../domain/staleSubtask";
import { formatHandoffBrief, isEmptyHandoff, parseHandoff } from "../agents/handoff";
import { MAX_HANDOFF_CHARS } from "../domain/taskPipeline";
import { TaskRepository } from "../persistence/taskRepository";
import { Logger } from "../logging/logger";
import { ReviewPlanService } from "./reviewPlanService";
import { WorktreeClaimService, WorktreeSnapshot } from "./worktreeClaimService";
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
      /**
       * MCP servers the stage cannot work without. The implementation abandons the
       * run if the CLI reports any of them unavailable at startup, before the model
       * acts — see `domain/mcpReadiness.ts`.
       */
      requiredMcpServers?: readonly string[];
      /**
       * Which subtask the session is for, recorded against its OS process so an
       * extension host that crashes leaves something reapable — see
       * `domain/sessionProcesses.ts`.
       */
      subtaskId?: string;
      stageName?: string;
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
  | {
      kind: "blocked";
      stageId: string;
      stageName: string;
      reason?: string;
      /**
       * Set when the block is the worktree being on the wrong branch.
       *
       * Carried structurally rather than left in `reason` so the caller can offer to
       * fix it: the message tells you the git command to run, and being told a
       * command is not the same as being able to act.
       */
      branchMismatch?: BranchMismatch;
    }
  /** A stage needs information the brief does not contain. */
  | {
      kind: "needsInput";
      stageId: string;
      stageName: string;
      subtaskId: string;
      /** One entry per question; each is answered separately. */
      questions: string[];
    }
  /**
   * A stage that ships is next, and work earlier stages declined has no owner.
   *
   * Its own outcome rather than a `blocked`: nothing failed and nothing needs
   * retrying. What it needs is a decision — who does this, or does it need doing
   * at all — and presenting it as a failure sends the reader looking for a bug.
   */
  | {
      kind: "deferredWork";
      stageId: string;
      stageName: string;
      items: { id: string; text: string; raisedByStageName: string }[];
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
 * Upper bound on transitions per invocation. Guards against a rule set or split that
 * somehow cycles.
 *
 * Proportional to the pipeline, because a flat bound stopped being a runaway guard and
 * became a wall. The old comment — "a real route is well under ten steps" — was written
 * against routes far shorter than the 27-stage ones now running, and on
 * `Purchases vs Sales Phase 3` reaching the first gate took 77 sessions against a limit
 * of 40: the advance ended in the middle, having done nothing wrong, and reported a
 * cycle it had not found.
 *
 * Every subtask is one step, so the work already in the pipeline is the honest basis,
 * plus headroom for the amendments and splits an advance creates as it goes. The flat 40
 * stays as a floor so a small route behaves exactly as before. It is still a *guard* and
 * not a budget: a genuine cycle re-runs one stage forever and exceeds any proportional
 * bound just as fast, while a long legitimate route now finishes rather than stopping
 * where nobody was watching.
 */
function maxSteps(pipeline: TaskPipeline | undefined): number {
  const subtasks = (pipeline?.stages ?? []).reduce(
    (total, stage) => total + stage.subtasks.length,
    0,
  );
  return Math.max(40, subtasks * 2 + (pipeline?.stages.length ?? 0));
}

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
    /**
     * Runs a stage's declared verification command.
     *
     * Optional: a stage with no `verify` never needs it, and a runner built without
     * one behaves exactly as before — so this adds a check without making process
     * execution a prerequisite for driving a route at all.
     */
    private readonly verifier?: VerificationCommandRunner,
    /**
     * Reads a file from a task's worktree, for a stage that executes a plan.
     *
     * Injected and optional for the reason the verifier is: the runner's tests need no
     * filesystem, and a route with no `planFile` never calls it. Narrow on purpose —
     * a path relative to the worktree, in, text or nothing out.
     */
    private readonly readWorktreeFile?: (
      worktreePath: string,
      relativePath: string,
    ) => Promise<string | undefined>,
    /**
     * Records the worktrees a stage creates, and reports overlap with another task.
     *
     * Optional like the rest: a route whose stages never leave their own worktree has
     * nothing to claim, and a runner built without this behaves exactly as before.
     */
    private readonly claims?: WorktreeClaimService,
    /**
     * Cumulative time this task's stages have spent blocked on a human, in ms.
     *
     * Sampled either side of the session and the difference kept, exactly as the
     * worktree list is snapshotted around a stage that may create one — because the
     * wait ends deep inside `AskUserService`, and there is no return path from an
     * answered question back to the subtask it unblocked.
     *
     * Optional like the rest: a runner built without it records no waits, and a route
     * whose stages never ask anything has none to record.
     */
    private readonly humanWaitMs?: (taskId: string) => number,
    /**
     * How long an `active` subtask no live run owns must be before `reclaimStale`
     * assumes it abandoned. A function, because it derives from a setting the user
     * can change between sweeps.
     *
     * Defaults to an hour: long enough that no legitimately running stage is
     * reachable — the owner's own stage timeout would have failed it first — and
     * short enough that a wedged task is recovered within one working session
     * rather than found by eye.
     */
    private readonly staleAfterMs: () => number = () => 60 * 60 * 1000,
    /**
     * Restores the tracked paths the project declared to be local environment, before a
     * stage's check reads the tree.
     *
     * Runs on **stages only**, which is why it lives here rather than anywhere a chat
     * session could reach it: a hand-driven session must never have files removed from
     * under it. Optional like the rest — a project declaring none, or a runner built
     * without this, behaves exactly as before.
     *
     * This is the one injected dependency that destroys work rather than reporting on
     * it, so what it did is announced in the stage's own report and never only in the
     * log. See `domain/worktreeDiscard.ts`.
     */
    private readonly discardLocalChanges?: (
      worktreePath: string,
      signal?: AbortSignal,
    ) => Promise<DiscardSelection | undefined>,
    /**
     * How many times a subtask whose session died on someone else's capacity is run
     * again before a human is told. A function, because it derives from a setting.
     *
     * Zero switches the retry off and restores the old behaviour exactly: a transient
     * failure then holds the stage on its first occurrence, which is still better than
     * failing it, but nothing is re-run unattended.
     */
    private readonly transientAttempts: () => number = () => DEFAULT_TRANSIENT_ATTEMPTS,
    /**
     * Waits between those attempts. Injected for the reason every clock here is: the
     * runner's tests must not spend five real minutes proving a backoff.
     */
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    /**
     * Model for amendment subtasks, when a cheaper one is configured — see
     * `resolveAmendmentModel`. Last in the list, and that is not arbitrary: every
     * argument here is positional, so inserting one in the middle silently shifts each
     * callback after it onto the wrong parameter. It typechecked as `any` and would have
     * run.
     *
     * A function because it is a setting the operator can change between advances.
     */
    private readonly amendmentModel: () => string | undefined = () => undefined,
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
  /**
   * Runs a stage's declared check, recording it where the stage's work is recorded.
   *
   * The command and its output go into the subtask's activity as well as the log, so
   * the report shows the evidence rather than only the verdict — a stage that failed
   * verification is exactly the one whose output someone needs.
   */
  private async runVerification(
    task: TaskWorkspace,
    stage: TaskStage,
    declared: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        command: string;
        outcome: CommandOutcome;
        discarded?: string;
        /** Placeholders nothing established, when the check was not run at all. */
        unresolved?: string[];
      }
    | undefined
  > {
    // Before the tree is judged, not after: the whole point is that these paths are
    // local environment and never work, so a check reading them as uncommitted work
    // fails a stage whose work is committed and pushed. It happened on four worktrees
    // at once, on the check standing between a route and a live publish.
    const selection = this.discardLocalChanges
      ? await this.discardLocalChanges(task.worktreePath, signal)
      : undefined;
    const discarded = selection ? describeDiscard(selection) : undefined;
    if (discarded) {
      // warn, not info: this removed files. Someone reading the log for why a change
      // vanished must find it without knowing to look.
      this.logger.warn(`Harness [${task.name}] "${stage.name}": ${discarded}`);
    }

    // A check written once for a route could not name the task it was certifying, so a
    // script that had to reject a worktree parked on *another* ticket degraded into an
    // existence check — one that passes in exactly the case that matters.
    const { command, used, unknown, missing } = substitutePlaceholders(declared, {
      taskName: task.name,
      branch: task.branchName,
      baseBranch: task.baseBranch,
      worktreePath: task.worktreePath,
      // So a check can name its own script from the root. The command runs with the
      // worktree as cwd, so a relative path runs the branch's copy — which is how a task
      // branch cut before two fixes to a promotion check ran the old one and failed on a
      // bug already fixed on DEV, with a message describing the fixed behaviour.
      repoRoot: task.repositoryRoot,
      // What the task was linked to, else whatever its name carries. A promotion check
      // is scoped by ticket and fails when it matches nothing, so a task whose name has
      // no reference failed its promotion while every commit on its branch named one.
      ticket: taskTicket(task),
    });
    if (missing.length > 0) {
      // Not run at all, which is the correction. Running it was defensible — a scoped
      // check must never run unscoped, so failing is right — but it failed as a *check
      // result*, and a promotion check reporting exit 4 says "this work is not on the
      // target branch". The real cause was a task linked to no ticket, and it was
      // legible only as a warning in the output channel, several layers from the
      // failure. An operator read the script's own error text to find it.
      //
      // So the stage still stops, and the reason now names its own remedy. The
      // distinction is exactly the one `stageEvidence` insists on elsewhere: a check
      // that could not be scoped never ran, and must not be recorded as one that did.
      const named = missing.map((name) => `\${${name}}`).join(", ");
      this.logger.error(
        `Harness [${task.name}] "${stage.name}" verification names ${named}, which ` +
          "nothing about this task establishes. The check was not run.",
      );
      return {
        command,
        unresolved: missing,
        outcome: {
          exitCode: -1,
          output:
            `The check declares ${named}, and nothing about this task establishes ` +
            `${missing.length > 1 ? "them" : "it"}.\n\n` +
            "It was not run: a check scoped by ticket must never run unscoped, and a " +
            "failure from running it anyway reads as the work not being done.\n\n" +
            "Link the task to its ticket (Set Ticket Reference…), or put the reference " +
            "in the task's name.",
        },
      };
    }
    if (unknown.length > 0) {
      // Not an error: `${...}` is shell syntax, so most of these are deliberate. Said
      // out loud because the other cause is a misspelled placeholder, and that reaches
      // the script as a literal `${taskname}` and fails somewhere far less obvious.
      this.logger.warn(
        `Harness [${task.name}] "${stage.name}" verification names ` +
          `${unknown.map((name) => `\${${name}}`).join(", ")}, which the harness does not ` +
          "substitute — passed through to the shell as written.",
      );
    }
    this.logger.info(
      `Harness [${task.name}] verifying "${stage.name}": ${redactSecrets(command)}` +
        (used.length > 0 ? ` (substituted ${used.join(", ")})` : ""),
    );
    const outcome = await this.verifier!.run(command, task.worktreePath, signal);
    if (outcome.exitCode === 0) {
      this.logger.info(`Harness [${task.name}] "${stage.name}" verified (exit 0).`);
    } else {
      this.logger.error(
        `Harness [${task.name}] ${describeVerification(command, outcome)}`,
      );
    }
    // The substituted command travels with the outcome: it is what actually ran, so it
    // is what the failure reason and the stage's activity must show. Reporting the
    // declared form would send a reader to run something different by hand.
    return {
      command,
      // Carried into the recorded output, so the stage report shows it beside the check
      // it enabled. A discard visible only in the log is one nobody reading the report
      // can connect to the file that is no longer changed.
      outcome: discarded
        ? { ...outcome, output: `${discarded}\n\n${outcome.output}` }
        : outcome,
      ...(discarded ? { discarded } : {}),
    };
  }

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
   * The model for one subtask: the stage's, unless this is an amendment and a cheaper
   * model is configured for those. See `resolveAmendmentModel` for the measurement.
   */
  private modelForSubtask(
    task: TaskWorkspace,
    stage: TaskStage,
    subtask: Subtask,
  ): string | undefined {
    return resolveAmendmentModel(
      this.amendmentModel?.(),
      subtask,
      this.modelFor(task, stage),
    );
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
      // Named by the operator, never inferred: a guessed reference would be stated
      // to every stage with the authority of one they chose, and being told the
      // wrong document governs the work is the error this exists to prevent.
      references: task.references?.map((reference) => ({
        path: reference.path,
        note: reference.note,
        // Carried through so the prompt can keep the two tiers apart: an operator
        // entry decides the work, a discovered one only saves a stage the twenty-odd
        // commands an earlier stage spent finding it.
        origin: reference.origin,
      })),
      // Every later stage sees an approval note: guidance given at a gate is about the
      // work that follows, so expiring it at the next stage boundary would waste it.
      // A send-back's findings and a re-run's reason are not that — they are about one
      // stage's output, and `guidanceFor` keeps them there. See its comment for the two
      // failures that produced the distinction.
      guidance: guidanceFor(task.pipeline, stageId),
      // Withheld on the experiment's other arm, and withheld *here* rather than at
      // recording: the stages still write their handoff blocks and the pipeline still
      // stores them, so the two arms stay comparable on what the stages did and the
      // run is still readable afterwards. An experiment that destroys its own
      // evidence measures one number and answers no question about why.
      handoffs:
        stageId && !handoffsSuppressed(task.pipeline)
          ? handoffsBefore(task.pipeline!, stageId)
          : undefined,
      // Named from the live pipeline rather than the route definition, so rule-added
      // review stages appear too — a stage told a route that omits them would raise
      // the very work those reviews exist to do.
      routeStages: stageId ? routeOutline(task.pipeline, stageId) : undefined,
    };
  }

  /**
   * Subtasks *this* runner started. A persisted `active` subtask missing from
   * here was left behind by a previous extension host, which cannot still be
   * working on it — see `reclaimStale`, and the `running` branch of the driver,
   * which reclaims one it is about to run regardless of age.
   */
  private readonly startedSubtasks = new Set<string>();

  /**
   * How many times each subtask has been re-run after a transport failure.
   *
   * In memory rather than on the pipeline, deliberately. The count exists to stop
   * one advance looping forever on an outage; a reload or a fresh Advance Route is a
   * human deciding to try again, and that should get a fresh budget rather than
   * inherit an exhausted one from a state file written an hour ago. Nothing about the
   * work is recorded here, so nothing is lost with it.
   */
  private readonly transientRetries = new Map<string, number>();

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
   * Puts back `active` subtasks that no live run can account for.
   *
   * The gap this closes: every mechanism that ends a subtask — the session's
   * status listener, the per-subtask timeout, the driver awaiting the run — lives
   * in this host's memory, so a host that dies mid-subtask takes all three with
   * it and leaves the record `active` with no reply, no activity and no cost. The
   * reclaim in the driver's `running` branch only ever fired on the next advance,
   * which a wedged task is precisely what nobody orders.
   *
   * Reverted rather than failed, for the reason `cancel` reverts: the stage has
   * not been judged, so the route must resume from it rather than skip past it.
   * Whatever the lost session produced is gone either way — that is the cost of
   * the host dying, not of the reclaim.
   */
  async reclaimStale(
    task: TaskWorkspace,
    at: string,
  ): Promise<{ task: TaskWorkspace; reclaimed: StaleSubtask[] }> {
    const stale = staleActiveSubtasks(task.pipeline, {
      now: at,
      thresholdMs: this.staleAfterMs(),
      owned: (subtaskId) => this.startedSubtasks.has(subtaskId),
    });
    return this.revertAll(task, stale, (item, name) =>
      `Harness [${name}] reclaimed ${describeStaleSubtask(item)}. Its session ` +
      "ended without reporting back — most likely the extension host that owned it " +
      "was closed — so the subtask is pending again. Advance Route re-runs it.",
    );
  }

  /**
   * Puts back every `active` subtask of one named task, because the user stopped it.
   *
   * Both of `reclaimStale`'s guards are wrong here, and each was load-bearing for a
   * sweep. Ownership protects a subtask *this* host is genuinely running — but the
   * caller has just killed that session, so the record it left is the thing being
   * cleaned up, not evidence of work in flight. The age threshold protects another
   * host's work from being reclaimed out from under it — but a stop names one task,
   * and waiting an hour to act on an explicit instruction is not caution.
   *
   * Left as they were, a stop killed the process and persisted nothing: the subtask
   * stayed `active`, every later advance refused with "already running", and a
   * window reload rebuilt the same state from the same file, because the file is the
   * state. A stage that had finished was then unreachable from the UI entirely
   * (20 Aug 2026). Stop is the affordance people reach for when a task looks wedged,
   * so it is the one that must leave the record consistent.
   *
   * Only for an explicit stop. The sweep keeps both guards.
   */
  async reclaimStopped(
    task: TaskWorkspace,
    at: string,
  ): Promise<{ task: TaskWorkspace; reclaimed: StaleSubtask[] }> {
    const active = staleActiveSubtasks(task.pipeline, {
      now: at,
      // Nothing is too young to stop, and nothing is owned once it has been killed.
      thresholdMs: 0,
      owned: () => false,
    });
    // So a later sweep does not read a killed session as this host's live work.
    for (const item of active) this.startedSubtasks.delete(item.subtaskId);
    return this.revertAll(task, active, (item, name) =>
      `Harness [${name}] stopped ${describeStaleSubtask(item)}. Its session was ` +
      "killed, so the subtask is pending again. Advance Route re-runs it.",
    );
  }

  /**
   * Reverts each subtask in turn, saving as it goes.
   *
   * Saved per item rather than once at the end: a failure part-way through must
   * leave the subtasks already put back actually put back, since the whole purpose
   * is recovering a record nothing else can now correct.
   */
  private async revertAll(
    task: TaskWorkspace,
    items: readonly StaleSubtask[],
    describe: (item: StaleSubtask, taskName: string) => string,
  ): Promise<{ task: TaskWorkspace; reclaimed: StaleSubtask[] }> {
    if (items.length === 0) return { task, reclaimed: [] };

    let current = task;
    const reclaimed: StaleSubtask[] = [];
    for (const item of items) {
      const reverted = revertSubtask(current.pipeline!, item.subtaskId);
      if (!reverted.ok) {
        // Never fatal: the sweep runs over every task, and one unreadable record
        // must not stop the rest being recovered.
        this.logger.warn(
          `Harness [${current.name}] could not reclaim ${describeStaleSubtask(item)}: ` +
            reverted.error.message,
        );
        continue;
      }
      current = await this.save(current, reverted.value);
      reclaimed.push(item);
      this.logger.warn(describe(item, current.name));
    }
    return { task: current, reclaimed };
  }

  /** Whether this host is the one running a given subtask. */
  ownsSubtask(subtaskId: string): boolean {
    return this.startedSubtasks.has(subtaskId);
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

    // Cleared before anything runs, so a recorded stop is never a stale explanation of
    // a run that has since moved on. Written back only if it was set: an advance must
    // not cost a state-file write merely by starting.
    if (current.pipeline?.lastAdvance) {
      current = await this.save(current, { ...current.pipeline, lastAdvance: undefined });
    }

    const limit = maxSteps(current.pipeline);
    for (let step = 0; step < limit; step++) {
      if (signal?.aborted) return { outcome: { kind: "cancelled" }, steps: await this.recordStop(current, "cancelled", step, steps) };

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
              branchMismatch: mismatch,
            },
            steps,
          };
        }
      }

      switch (action.kind) {
        case "done":
          return { outcome: { kind: "done" }, steps };

        case "awaitApproval": {
          // A gate the route declares an evidence gate, whose evidence is clean, is
          // passed by the harness rather than waited on. Measured across 17 pipelines:
          // 271 of 320 approvals sat on stages that were not authority boundaries, and
          // only 16 approvals in the whole corpus carried a note — so the common case
          // here is a route stopped for a click that supplies nothing.
          //
          // Not the agent approving itself: `certifyStage` reads only what independent
          // machinery recorded — a parsed verdict, parsed findings, a process exit code,
          // deferrals recorded when they were raised. See `domain/stageAuthority.ts`.
          const certified = certifyStage(pipeline, action.stage.id);
          if (certified.admissible) {
            // Through `approveStage`, deliberately, rather than by settling the stage
            // here: it enforces the checklist, the operator's outstanding actions and
            // plan-step accounting, and an automatic pass must clear exactly the same
            // bar a person does. A refusal from it means the route stops as before.
            const approved = approveStage(pipeline, action.stage.id, new Date().toISOString());
            if (approved.ok) {
              // No intervention recorded. `interventions` counts moments a human had to
              // act, and this is precisely one that did not happen — the same rule the
              // runner's own automatic reverts follow. Booking it would make the number
              // the harness is judged on unable to show the improvement.
              current = await this.save(current, approved.value);
              // Announced, because a gate that passed with nobody present is otherwise
              // indistinguishable from a gate that was never there. The rule a discarded
              // file and truncated output both follow.
              steps.push(
                `Passed "${action.stage.name}" on evidence: ${certified.reason}.`,
              );
              this.logger.info(
                `Harness [${current.name}] certified "${action.stage.name}" without ` +
                  `approval: ${certified.reason}.`,
              );
              continue;
            }
            this.logger.warn(
              `Harness [${current.name}] could not certify "${action.stage.name}": ` +
                approved.error.message,
            );
          }

          // The reason is carried into the step so the operator being stopped can see
          // why this gate needed them, rather than inferring it from the stage report.
          steps.push(
            `Stopped for approval at "${action.stage.name}" — ${certified.reason}.`,
          );
          return {
            outcome: {
              kind: "awaitingApproval",
              stageId: action.stage.id,
              stageName: action.stage.name,
            },
            steps,
          };
        }

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

        case "deferredWork": {
          // Stops *in front of* the stage that ships rather than inside it. The
          // failure this exists for is a live publish that halted on a structure
          // nobody had created; halting a step earlier, naming what was declined
          // and who declined it, is the whole difference.
          const listed = action.items
            .map((item) => `${item.text} (declined by "${item.raisedByStageName}")`)
            .join("; ");
          this.logger.warn(
            `Harness [${current.name}] holding "${action.stage.name}": ` +
              `${action.items.length} deferred item(s) with no owner. ${listed}`,
          );
          steps.push(
            `Held before "${action.stage.name}": ${action.items.length} item(s) ` +
              `every stage declined and nobody picked up.`,
          );
          return {
            outcome: {
              kind: "deferredWork",
              stageId: action.stage.id,
              stageName: action.stage.name,
              items: action.items.map((item) => ({
                id: item.id,
                text: item.text,
                raisedByStageName: item.raisedByStageName,
              })),
            },
            steps,
          };
        }

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
          // The transport failed, not the stage. Wait, then round again: the subtask
          // is pending, so `nextAction` hands back the same one. A retry costs a step
          // of the loop's budget, which is right — an outage should exhaust the
          // advance rather than be invisible in it.
          if (result.transient) {
            await this.delay(result.transient.waitMs);
            if (signal?.aborted) return { outcome: { kind: "cancelled" }, steps };
            continue;
          }
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

    return {
      outcome: { kind: "exhausted", steps: limit },
      steps: await this.recordStop(current, "exhausted", limit, steps),
    };
  }

  /**
   * Persists why an advance stopped, and says so in the run summary.
   *
   * Only for the two outcomes that leave no other trace. A failed stage, a question, a
   * held call and a gate all record themselves on the pipeline, and duplicating them
   * here would give the tree two sources for one fact — the disagreement `stageHistory`
   * and the findings summary already demonstrated.
   *
   * A save failure is swallowed on purpose: this is an explanation, and losing the
   * advance's own report in order to complain about not being able to file one would
   * trade a missing note for a missing outcome.
   */
  private async recordStop(
    task: TaskWorkspace,
    reason: "exhausted" | "cancelled",
    steps: number,
    summary: string[],
  ): Promise<string[]> {
    if (!task.pipeline) return summary;
    summary.push(
      reason === "exhausted"
        ? `Stopped after ${steps} steps without reaching a gate. Advance again to continue.`
        : "Stopped before finishing. Advance again to continue.",
    );
    try {
      await this.save(task, {
        ...task.pipeline,
        lastAdvance: { reason, at: new Date().toISOString(), steps },
      });
    } catch (error) {
      this.logger.warn(
        `Harness [${task.name}] could not record why the advance stopped: ${String(error)}`,
      );
    }
    return summary;
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
      {
        model: this.modelFor(task, action.stage),
        // Split too: a planner without the tracker invents the ticket's contents
        // and produces a plausible list of subtasks for work nobody asked for,
        // which every later stage then executes faithfully.
        requiredMcpServers: action.stage.requiredMcpServers,
      },
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
    /** The session died on the transport. Wait this long and run it again. */
    transient?: { reason: string; waitMs: number; attempt: number; budget: number };
  }> {
    const { stage, subtask } = action;

    // Read before anything starts, because a stage whose plan is missing must not run
    // at all: it would improvise from the brief, report done, and leave nobody able to
    // say which steps happened — the state this whole mechanism exists to prevent.
    let planSteps: PlanStep[] | undefined;
    if (stage.planFile && this.readWorktreeFile) {
      const document = await this.readWorktreeFile(task.worktreePath, stage.planFile);
      const parsed = document ? parsePlanSteps(document) : [];
      if (!document || parsed.length === 0) {
        const reason = document
          ? `${stage.planFile} has no numbered steps to account for`
          : `${stage.planFile} does not exist in the worktree`;
        this.logger.error(
          `Harness [${task.name}] "${stage.name}" not run: ${reason}. ` +
            "The stage executes that plan, so running it would leave its steps unaccounted for.",
        );
        steps.push(`"${stage.name}" was not run: ${reason}.`);
        return {
          task: await this.save(task, recordStageBlocked(task.pipeline!, stage.id, reason)),
          failed: true,
          reason,
        };
      }
      planSteps = parsed;
      steps.push(
        `"${stage.name}" must account for ${parsed.length} step(s) of ${stage.planFile}.`,
      );
    }

    // Taken before the session, so worktrees it creates can be told from ones it
    // borrowed. Only for a stage the route lets move the tree — that is the stage kind
    // that makes promotion and publish worktrees, and asking git for its list on every
    // subtask of every stage would be a process launch to learn nothing.
    const claimsBefore =
      stage.mayChangeBranch && this.claims
        ? await this.claims.snapshot(task.repositoryRoot)
        : undefined;

    const context = this.contextFor(task, stage.id);

    // A behaviour review is asked for a checklist, an assessment for a reading of
    // what already exists; everything else does the work.
    // A correction outranks the stage's kind. Even a review being corrected is being
    // *repaired*, not re-run, and asking it for a fresh review would discard the
    // reading that the correction is an amendment to.
    const prompt = subtask.correction
      ? correctionPrompt(
          context,
          stage,
          subtask.correction.finding,
          previousReport(stage, subtask.id),
        )
      : stage.kind === "assessment"
        ? assessmentPrompt(context, stage)
        : producesChecklist(stage.kind)
          ? behaviourReviewPrompt(
              context,
              stage,
              // From the live pipeline, so rule-added gates count and a review is never
              // told about a gate this task does not have.
              declaredScopes(task.pipeline!),
            )
          : subtaskPrompt(context, stage, subtask, planSteps);

    let pipeline = task.pipeline!;
    // Registered before the session runs, so the steps exist to be unaccounted for
    // even if it dies mid-turn. A stage whose session vanished has accounted for
    // nothing, and that has to be visible rather than inferred from an absence.
    if (planSteps) pipeline = recordPlanSteps(pipeline, stage.id, planSteps);
    const started = startSubtask(pipeline, subtask.id, {
      at: new Date().toISOString(),
    });
    if (started.ok) {
      pipeline = started.value;
      this.startedSubtasks.add(subtask.id);
      task = await this.save(task, pipeline);
    }

    const taskId = task.id;
    // Read before the session, for the same reason `claimsBefore` is: what this
    // subtask waited on a human is the difference between two readings of a
    // cumulative total, and there is nothing else that can attribute a wait to the
    // subtask it held up.
    const waitBefore = this.humanWaitMs?.(taskId) ?? 0;
    let reply;
    try {
      reply = await this.sessions.run(task, prompt, `${stage.id}:${subtask.id}`, {
        subtaskId: subtask.id,
        stageName: stage.name,
        model: this.modelForSubtask(task, stage, subtask),
        requiredMcpServers: stage.requiredMcpServers,
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

    // Folded in here, before anything reads the activity, so every path that persists
    // it carries the wait. Without this the time an operator took to answer sits
    // inside the subtask's span recorded as the model working — which is how a route
    // came to report 4% idle while one of its stages had asked two questions.
    const waitedOnHuman = (this.humanWaitMs?.(taskId) ?? 0) - waitBefore;
    if (waitedOnHuman > 0) {
      reply = { ...reply, activity: withHumanWait(reply.activity, waitedOnHuman) };
      steps.push(
        `"${subtask.title}" spent ${Math.round(waitedOnHuman / 1000)}s waiting on an answer.`,
      );
    }

    // One ordered read of every protocol marker. The order between them is
    // load-bearing and now lives in `readStageReply`, with a test per rule, rather
    // than in the adjacency of six statements here.
    const {
      verdict,
      handoff: handoffText,
      deferrals: deferred,
      blocked,
      actions,
      correctionDeclined,
      stepAccounts,
      report: reportText,
    } = readStageReply(reply.text);
    reply = { ...reply, text: reportText };

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
          task: await this.recordAppearedWorktrees(
            await this.save(task, pipeline),
            claimsBefore,
            stage,
            steps,
            reply.activity?.commands ?? [],
          ),
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
      return {
        task: await this.recordAppearedWorktrees(
          await this.save(task, pipeline),
          claimsBefore,
          stage,
          steps,
          reply.activity?.commands ?? [],
        ),
        failed: false,
        cancelled: true,
      };
    }

    // A session that died on somebody else's capacity has told us nothing about the
    // stage. Recorded as a failure it fails the whole stage, `nextAction` reports
    // `blocked`, and the only way onward is `revertToStage` — which discards the stage
    // and everything after it. That is what a 529 used to cost on a correction run:
    // the same price as a wrong approach, for a reason that was never about the work.
    //
    // Reverted rather than judged, exactly as a stop and a question are: nothing has
    // been decided about this subtask, so the route must resume from it.
    if (!reply.ok && isTransientFailure(reply.error)) {
      const attempt = (this.transientRetries.get(subtask.id) ?? 0) + 1;
      const budget = Math.max(0, this.transientAttempts());
      const cause = reply.error ?? "the transport failed";
      const reverted = revertSubtask(pipeline, subtask.id);
      if (reverted.ok) pipeline = reverted.value;
      // Not counted as an intervention: `revertSubtask` records one only when given a
      // clock, and a retry the harness performs itself is not supervision.
      //
      // Dropped from the owned set too, or the next advance reads a subtask this host
      // abandoned as one it is still running and refuses to touch it.
      this.startedSubtasks.delete(subtask.id);
      // Recorded on this exit like every other, because a promotion stage that died
      // mid-turn has still left whatever worktrees it made.
      const saved = await this.recordAppearedWorktrees(
        await this.save(task, pipeline),
        claimsBefore,
        stage,
        steps,
        reply.activity?.commands ?? [],
      );

      if (attempt <= budget) {
        this.transientRetries.set(subtask.id, attempt);
        const waitMs = backoffMs(attempt);
        // warn, not info: an operator watching a route stall deserves to find the
        // reason without turning the log level up.
        this.logger.warn(
          `Harness [${task.name}] "${stage.name}" hit a transport failure: ${cause}. ` +
            `Nothing about the stage is wrong — retrying in ` +
            `${Math.round(waitMs / 1000)}s (attempt ${attempt} of ${budget}).`,
        );
        steps.push(
          `"${subtask.title}" hit a transport failure; retrying in ` +
            `${Math.round(waitMs / 1000)}s (${attempt} of ${budget}).`,
        );
        return { task: saved, failed: false, transient: { reason: cause, waitMs, attempt, budget } };
      }

      this.transientRetries.delete(subtask.id);
      // Held, never failed. The stage has not been judged and there is nothing for
      // anyone to read in its account — so what it needs is another advance once the
      // API is back, not the discard that a failed stage's only remedy would demand.
      const reason =
        `the transport kept failing (${cause}) after ${budget} retr` +
        `${budget === 1 ? "y" : "ies"}. Nothing about the stage is wrong; ` +
        "Advance Route runs it again.";
      this.logger.error(`Harness [${task.name}] "${stage.name}" held: ${reason}`);
      steps.push(`"${stage.name}" is held: ${reason}`);
      return {
        task: await this.save(saved, recordStageBlocked(saved.pipeline!, stage.id, reason)),
        failed: true,
        reason,
      };
    }
    // Past that point the subtask reached an outcome of its own, so the retry budget
    // it may have spent belongs to a failure that is over.
    this.transientRetries.delete(subtask.id);

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
      return {
        task: await this.recordAppearedWorktrees(
          await this.save(task, pipeline),
          claimsBefore,
          stage,
          steps,
          reply.activity?.commands ?? [],
        ),
        failed: false,
        question,
      };
    }

    // The agent has said it is done; now something other than the agent decides.
    //
    // This is the one place a stage outcome stops being self-reported. Run only when
    // the stage is about to settle — the last unresolved subtask — because the check
    // certifies the stage's work, not each unit of it, and re-running a build once
    // per subtask would cost minutes to learn the same thing.
    const verification =
      reply.ok && stage.verify && this.verifier && isLastUnresolved(stage, subtask.id)
        ? await this.runVerification(task, stage, stage.verify, signal)
        : undefined;
    // Recorded whichever way it went, and before the outcome is decided: absence has
    // to mean "no check ran", or a stage that declared one and never executed it is
    // indistinguishable from one whose build went green. See `stageEvidence`.
    if (verification?.discarded) {
      // In the steps as well as the report: the steps are what the operator reads to
      // see what the advance did, and "files were restored" is the kind of thing they
      // must not have to go looking for.
      steps.push(`"${stage.name}": ${verification.discarded.split("\n")[0]}`);
    }
    if (verification && !verification.unresolved) {
      // Only a check that ran. `TaskStage.verification` means "something other than the
      // agent certified this", and a command the runner declined to execute certifies
      // nothing — recording it would make the stage report claim a check happened.
      const noted = recordVerification(pipeline, stage.id, {
        command: verification.command,
        exitCode: verification.outcome.exitCode,
        at: new Date().toISOString(),
      });
      if (noted.ok) pipeline = noted.value;
    }
    if (verification?.unresolved) {
      // Stops the stage exactly as a failed check does, but says why in the words of
      // the remedy rather than in an exit code.
      const named = verification.unresolved.map((name) => `\${${name}}`).join(", ");
      reply = {
        ...reply,
        ok: false,
        error:
          `The check for this stage names ${named}, which nothing about this task ` +
          "establishes, so it was not run. Link the task to its ticket, or put the " +
          "reference in the task's name, then re-run this stage.",
      };
      steps.push(`"${stage.name}" could not be verified: ${named} is not established.`);
    } else if (verification && verification.outcome.exitCode !== 0) {
      // Overrides the reply: the session ended cleanly and the work is not proven.
      reply = {
        ...reply,
        ok: false,
        error: describeVerification(verification.command, verification.outcome),
      };
      steps.push(
        `"${stage.name}" failed verification (exit ${verification.outcome.exitCode}).`,
      );
    } else if (verification) {
      steps.push(`"${stage.name}" passed verification.`);
    }

    if (reply.ok && stage.kind === "assessment") {
      const assessments = parseAssessments(reply.text);
      const recorded = recordAssessments(pipeline, stage.id, assessments);
      if (recorded.ok) pipeline = recorded.value;
      const done = assessments.filter((entry) => entry.done).length;
      steps.push(
        assessments.length === 0
          ? `"${stage.name}" reported on no stages — every stage will run.`
          : `"${stage.name}" found ${done} of ${assessments.length} stage(s) already ` +
            `done. They are skipped only once you approve this stage.`,
      );
    }

    if (reply.ok && producesChecklist(stage.kind)) {
      const scopes = declaredScopes(pipeline);
      const items = parseChecklistReply(reply.text, scopes);
      const recorded = recordChecklist(pipeline, stage.id, items);
      if (recorded.ok) pipeline = recorded.value;
      steps.push(
        items.length > 0
          ? `"${stage.name}" raised ${items.length} verification item(s).`
          : `"${stage.name}" found nothing needing manual verification.`,
      );
      // Said out loud when the route asked for a distinction and the review made none.
      // Every item then falls to the fallback gate, which is safe but is not what the
      // route describes — and an operator reading "12 items" at one gate cannot tell
      // that from a change genuinely having nothing to check anywhere else.
      if (scopes.length > 0 && items.length > 0) {
        const tagged = items.filter((entry) => entry.scope).length;
        if (tagged === 0) {
          steps.push(
            `"${stage.name}" tagged none of its ${items.length} item(s) with a ` +
              `verification stage, so all of them fall to the last one.`,
          );
          this.logger.warn(
            `Harness [${task.name}] ${stage.name} ignored the scope instruction: ` +
              `none of ${items.length} item(s) named ${scopes.join(" or ")}. They will all ` +
              "be asked for at the final scoped gate.",
          );
        } else {
          const byScope = scopes
            .map((scope) => `${items.filter((i) => i.scope === scope).length} ${scope}`)
            .join(", ");
          const untagged = items.length - tagged;
          steps.push(
            `Split across verification stages: ${byScope}` +
              (untagged > 0 ? `, ${untagged} untagged` : "") + ".",
          );
        }
      }
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
      // The check is appended to what the stage did, not kept apart from it: it ran
      // in the same worktree for the same purpose, and a reader asking "what proves
      // this?" is reading this section.
      activity: verification
        ? withVerification(reply.activity, verification.command, verification.outcome)
        : reply.activity,
    });
    if (finished.ok) pipeline = finished.value;

    // A correction now knows what it touched, which is the first moment the cascade
    // it caused can be questioned. Amendments the written paths rule out are taken
    // back before anybody pays for them — see `domain/amendmentReach.ts` for the 29
    // of 32 that wrote nothing. Reported, never silent: a review returning to
    // "passed" without a word looks exactly like one that was skipped.
    if (reply.ok && subtask.correction && !subtask.correction.upstream) {
      const before = pipeline;
      pipeline = narrowAmendments(pipeline, stage.id, subtask.id);
      const spared = pipeline.stages.filter(
        (s, i) => s.subtasks.length < before.stages[i].subtasks.length,
      );
      if (spared.length > 0) {
        steps.push(
          `Left settled, unreachable from what this correction wrote: ` +
            `${spared.map((s) => `"${s.name}"`).join(", ")}.`,
        );
      }
    }

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
        // Before holding: a review that named the stage which should fix what it found
        // can have that applied, where the route permits it and the target is one
        // `sendBackTo` already allows. Measured across 17 pipelines, 19 of 68 guidance
        // notes are the send-back text the harness composes itself — the operator's
        // whole contribution to each was picking a target and clicking.
        //
        // The reviewer proposes and this adjudicates, rather than the harness deriving
        // a target: run against those 19, ordering agreed with the operator 11 times
        // and disagreed 7. See `domain/repairProposal.ts`.
        const applied: string[] = [];
        const refused: string[] = [];
        if (stage.autoRepair) {
          for (const proposal of parseRepairProposals(reply.text)) {
            const ruling = adjudicateRepair(pipeline, stage.id, proposal);
            if (!ruling.admissible) {
              refused.push(`"${proposal.target}" (${ruling.reason})`);
              continue;
            }
            // Through `correctStage`, so the repair keeps everything the target already
            // produced and the stages behind it are amended rather than rebuilt. No new
            // invalidation path: this decides a target and nothing else.
            const corrected = correctStage(pipeline, ruling.stage.id, {
              finding: formatSendBackNote(stage.name, ruling.finding),
              at: new Date().toISOString(),
            });
            if (!corrected.ok) {
              refused.push(`"${ruling.stage.name}" (${corrected.error.message})`);
              continue;
            }
            pipeline = corrected.value;
            applied.push(ruling.stage.name);
          }
        }

        if (applied.length > 0) {
          // Announced, and no intervention recorded: nothing a human did happened here.
          // A repair that appears in the route with no account of why it exists is the
          // failure `stageHistory` was built to fix, so the stage it came from is named.
          steps.push(
            `"${stage.name}" found ${summariseFindings(findings) ?? "findings"} and ` +
              `sent them back to ${applied.map((n) => `"${n}"`).join(", ")}.`,
          );
          this.logger.info(
            `Harness [${task.name}] ${stage.name} repaired ${applied.join(", ")} ` +
              "from its own findings.",
          );
        }

        // Held anyway when nothing was applied. A refused proposal is still reported,
        // because a named target the harness would not act on is a better starting
        // point for the operator than the prose it used to be.
        if (applied.length === 0) {
          const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
          if (held.ok) {
            pipeline = held.value;
            const summary = summariseFindings(findings) ?? "findings";
            steps.push(
              `"${stage.name}" found ${summary} — held for you.` +
                (refused.length > 0 ? ` It proposed ${refused.join("; ")}.` : ""),
            );
            this.logger.warn(
              `Harness [${task.name}] ${stage.name} found ${summary}; holding the route. ` +
                "Approve to accept them, or send the findings back to an earlier stage.",
            );
          }
        }
      }
    }

    // Recorded only on success, and only for stages the route marks `handoff`. A
    // failed stage's conclusion is not a conclusion, and carrying it forward would
    // present a guess to every stage after it as established fact.
    // Recorded whatever the outcome, unlike the handoff. A stage that declined
    // work and then failed still saw the gap, and that observation is the only
    // warning anyone gets before a deployment runs without it.
    // Route mutations the stage proposed. Applied before deferrals are recorded, so a
    // stage that both proposed a reverify and declined the same work does not leave an
    // item behind describing work the harness has just scheduled.
    //
    // Both are opt-in per stage (`mayMutateRoute`), and both only ever *add* work. See
    // `domain/routeMutation.ts` for the evidence: 15 of 138 deferrals were an earlier
    // stage's output going stale, 11 of them the same artefact on one task, every one
    // answered "Later" because no operation could express it.
    if (reply.ok && stage.mayMutateRoute) {
      for (const proposal of parseReverifyProposals(reply.text)) {
        const ruling = adjudicateReverify(pipeline, stage.id, proposal);
        if (!ruling.admissible) {
          this.logger.warn(
            `Harness [${task.name}] ${stage.name} proposed re-running ` +
              `"${proposal.target}": ${ruling.reason}.`,
          );
          continue;
        }
        // Through `correctStage` with an upstream attribution, so it is recorded as an
        // amendment rather than a correction: the stage was right when it ran and had
        // the ground moved under it, and the ledger has to say which.
        const applied = correctStage(pipeline, ruling.stage.id, {
          finding: ruling.reason,
          at: new Date().toISOString(),
          upstream: { stageId: stage.id, stageName: stage.name },
        });
        if (!applied.ok) {
          this.logger.warn(
            `Harness [${task.name}] could not re-run "${ruling.stage.name}": ` +
              applied.error.message,
          );
          continue;
        }
        pipeline = applied.value;
        steps.push(
          `"${stage.name}" found "${ruling.stage.name}" stale — re-running it.`,
        );
      }

      for (const proposal of parseInsertProposals(reply.text)) {
        const ruling = adjudicateInsert(pipeline, stage.id, proposal, ruleInsertionIndex);
        if (!ruling.admissible) {
          this.logger.warn(
            `Harness [${task.name}] ${stage.name} proposed inserting ` +
              `"${proposal.name}": ${ruling.reason}.`,
          );
          continue;
        }
        const spliced = insertStage(pipeline, ruling.stage, ruling.index);
        if (!spliced.ok) {
          this.logger.warn(
            `Harness [${task.name}] could not insert "${proposal.name}": ` +
              spliced.error.message,
          );
          continue;
        }
        pipeline = spliced.value;
        // Announced with the stage that asked for it, because a stage in a route that
        // nobody declared and nothing accounts for is unreadable afterwards.
        steps.push(
          `"${stage.name}" added "${ruling.stage.name}" to the route: ${proposal.intent}`,
        );
      }
    }

    if (deferred.length > 0) {
      pipeline = recordDeferrals(pipeline, stage.id, deferred, new Date().toISOString());
      this.logger.info(
        `Harness [${task.name}] ${stage.name} deferred ${deferred.length} item(s): ` +
          deferred.join(" | "),
      );
    }

    // A stage that says it did not do its work must not pass, whatever its kind. The
    // review path above covers a *judgement* about someone else's work; this covers a
    // stage reporting that its own objective went undone -- which was previously
    // indistinguishable from success, because a session ending tidily is all
    // `finishSubtask(..., "done")` records.
    //
    // Held rather than failed, like a blocking review: the stage did the right thing
    // by refusing, and what is needed is a human deciding what to do about the missing
    // prerequisite, not a red mark against the agent that spotted it.
    // Recorded before the hold below, so a stage that both named steps and refused
    // still carries the steps. Held whatever the stage's kind: a pull request nobody
    // opened makes the next stage wrong, and several routes have no human gate between
    // a promote and what follows, so waiting for one would lose it.
    if (reply.ok && actions.length > 0) {
      pipeline = recordActions(pipeline, stage.id, actions);
      const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
      if (held.ok) pipeline = held.value;
      steps.push(
        `"${stage.name}" needs ${actions.length} step(s) from you — held for you.`,
      );
      this.logger.warn(
        `Harness [${task.name}] ${stage.name} needs you to: ${actions.join(" | ")}`,
      );
    }

    // Per-step accounting for a stage executing a written plan. Recorded whatever the
    // outcome — a stage that got three steps in and then failed has told you which
    // three, and losing that would make the re-run start from nothing.
    if (planSteps) {
      const now = new Date().toISOString();
      pipeline = recordStepAccounts(pipeline, stage.id, stepAccounts, now);

      // A step the stage says it did not do becomes a deferral, rather than a second
      // parallel mechanism. It is the same fact arriving by a different route — work
      // that needs doing and has no owner — so it gets the machinery that already
      // exists for one: the hold in front of the next stage that ships, and a
      // settlement that requires a sentence rather than a tick.
      const notDone = stepAccounts.filter((account) => account.state === "not-done");
      if (notDone.length > 0) {
        pipeline = recordDeferrals(
          pipeline,
          stage.id,
          notDone.map((account) => {
            const step = planSteps!.find((s) => s.number === account.number);
            return (
              `Plan step ${account.number}${step ? ` (${step.title})` : ""} was not done: ` +
              `${account.note ?? "no reason given"}`
            );
          }),
          now,
        );
        steps.push(
          `"${stage.name}" reported ${notDone.length} plan step(s) not done: ` +
            notDone.map((a) => a.number).join(", ") + ".",
        );
      }

      // Only once the stage has settled. A split stage's subtasks each account for the
      // steps they did, and holding on the first one's silence about the rest would
      // stop the stage before the subtask that does them has run.
      const missing = isLastUnresolved(stage, subtask.id)
        ? unaccountedPlanSteps(pipeline, stage.id)
        : [];
      if (missing.length > 0) {
        const held = holdStageForFindings(pipeline, stage.id, now);
        if (held.ok) pipeline = held.value;
        const listed = missing.map((step) => `${step.number}. ${step.title}`).join("; ");
        steps.push(
          `"${stage.name}" left ${missing.length} plan step(s) unaccounted for — held for you: ${listed}.`,
        );
        this.logger.warn(
          `Harness [${task.name}] ${stage.name} said nothing about ${missing.length} step(s) of ` +
            `${stage.planFile}: ${listed}. Holding the route: a step nobody accounted for reads ` +
            "exactly like a step that was done.",
        );
      }
    }

    if (reply.ok && blocked) {
      // Recorded before the hold, and independently of whether the hold takes effect:
      // the reason is the only account of what was missing, and a step line and a log
      // entry both vanish when the window closes.
      pipeline = recordStageBlocked(pipeline, stage.id, blocked);
      const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
      if (held.ok) {
        pipeline = held.value;
        steps.push(`"${stage.name}" could not proceed: ${blocked} — held for you.`);
        this.logger.warn(
          `Harness [${task.name}] ${stage.name} did not do its work: ${blocked} ` +
            "Holding the route rather than passing the stage.",
        );
      }
    }

    // A correction that says the finding needs a re-run. Held on exactly the machinery
    // a refusal uses, because it is the same shape of fact — the stage did not do what
    // it was asked and must not be recorded as having done it — and the alternative was
    // the bug this marker exists for: the session declined, ended tidily, and the route
    // read a clean exit as a completed fix.
    //
    // Honoured only on a correction subtask. An ordinary run has no correction to
    // decline, so the line there is a model quoting the protocol rather than using it,
    // and holding a route on that would make the marker's first cost a false stop.
    //
    // The reason is prefixed rather than stored raw: `blocked` is read by the tree, the
    // notification and the stage report, all of which say "could not proceed", and the
    // operator's next move here is a specific and destructive one they have to choose.
    if (reply.ok && correctionDeclined && subtask.correction) {
      const reason = `correction declined — this needs a re-run, not a fix: ${correctionDeclined}`;
      pipeline = recordStageBlocked(pipeline, stage.id, reason);
      const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
      if (held.ok) {
        pipeline = held.value;
        steps.push(
          `"${stage.name}" declined the correction: ${correctionDeclined} — held for you. ` +
            "Re-run the stage if you agree.",
        );
        this.logger.warn(
          `Harness [${task.name}] ${stage.name} declined a correction: ${correctionDeclined} ` +
            "Nothing was changed; holding the route rather than passing the stage.",
        );
      }
    }

    // The same fact as the marker above, observed rather than declared. A correction
    // that neither changed a file nor declined has done nothing, and passing it leaves
    // every stage behind it built on the version the finding called wrong -- which is
    // what happened when a plan correction argued a scope change in prose, wrote
    // nothing, and let eight stages run against the unchanged plan. Read from the
    // pipeline rather than the local `subtask`, so it sees the activity just recorded.
    if (reply.ok && !correctionDeclined) {
      const ran = pipeline.stages
        .find((s) => s.id === stage.id)
        ?.subtasks.find((s) => s.id === subtask.id);
      if (ran && correctionChangedNothing(ran)) {
        pipeline = recordStageBlocked(pipeline, stage.id, CORRECTION_CHANGED_NOTHING_REASON);
        const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
        if (held.ok) {
          pipeline = held.value;
          steps.push(`"${stage.name}" corrected nothing — held for you.`);
          this.logger.warn(
            `Harness [${task.name}] ${stage.name} ran a correction that wrote no files ` +
              "and did not decline. Holding rather than passing: read what it said, then " +
              "either approve it or re-run the stage.",
          );
        }
      }
    }

    // The one check that needs no cooperation from the reply. Every marker above
    // depends on the stage saying it did not do its work; this observes that it did
    // not. Read from the pipeline as it now stands, so it sees this subtask's activity
    // and every earlier one's.
    if (reply.ok) {
      const settled = pipeline.stages.find((s) => s.id === stage.id);
      if (
        settled &&
        !settled.subtasks.some((s) => s.status === "pending" || s.status === "active") &&
        changedNothing(settled)
      ) {
        pipeline = recordStageBlocked(pipeline, stage.id, CHANGED_NOTHING_REASON);
        const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
        if (held.ok) {
          pipeline = held.value;
          steps.push(`"${stage.name}" changed no files — held for you.`);
          this.logger.warn(
            `Harness [${task.name}] ${stage.name} is an implementation stage that wrote ` +
              "no files. Holding rather than passing: read what it did before approving.",
          );
        }
      }
    }

    // Documents this subtask went and found, so the stages behind it are told where
    // they are instead of each spending the twenty-odd commands `rc-plan` spent
    // downloading and parsing a ticket attachment -- or, far more often, not
    // bothering and using a neighbouring feature as the template. Recorded on the
    // task rather than the pipeline: a document belongs to the work, not to one run
    // of one stage, and it must survive a revert that discards the stage that found
    // it. Never overwrites an operator entry -- see `addDiscoveredReferences`.
    if (reply.ok) {
      const ran = pipeline.stages
        .find((s) => s.id === stage.id)
        ?.subtasks.find((s) => s.id === subtask.id);
      const found = ran?.activity ? discoveredDocuments(ran.activity) : [];
      if (found.length > 0) {
        const next = addDiscoveredReferences(
          task.references,
          found.map((document) => ({
            path: document.path,
            note: discoveredNote(document, stage.name),
          })),
          new Date().toISOString(),
        );
        // Length is the honest test for "anything new": the adder returns a copy
        // either way, so comparing identity would save the state file on every
        // subtask that reads a document it has already recorded.
        const added = next.length - (task.references?.length ?? 0);
        if (added > 0) {
          task = { ...task, references: next };
          this.logger.info(
            `Harness [${task.name}] ${stage.name} found ${added} new document(s); ` +
              "recorded on the task so later stages are told where they are rather " +
              "than each going to look.",
          );
        }
      }
    }

    // A plan that says it is not finished, in prose nobody reads. The mirror of the
    // `planSteps` hold below: that one catches a stage skipping a step of somebody
    // else's plan, this catches the author of a plan leaving questions in it. On
    // NMGB-2814 eleven of them settled `passed`, and each was answered by a guess in
    // eight later sessions -- including one that predicted the performance problem
    // the report shipped with.
    if (reply.ok && stage.planOutput && this.readWorktreeFile) {
      const settled = pipeline.stages.find((s) => s.id === stage.id);
      const running = settled?.subtasks.some(
        (s) => s.status === "pending" || s.status === "active",
      );
      if (settled && !running) {
        const { command: planPath } = substitutePlaceholders(stage.planOutput, {
          taskName: task.name,
          branch: task.branchName,
          baseBranch: task.baseBranch,
          worktreePath: task.worktreePath,
          repoRoot: task.repositoryRoot,
          ticket: taskTicket(task),
        });
        // A missing plan is not held here. `changedNothing` and the stage's own
        // report already speak to a planning stage that produced nothing, and
        // holding twice for one fact gives the operator two stops to clear.
        const document = await this.readWorktreeFile(task.worktreePath, planPath);
        const questions = document ? parsePlanQuestions(document) : [];
        if (questions.length > 0) {
          const reason = planQuestionsReason(planPath, questions);
          pipeline = recordStageBlocked(pipeline, stage.id, reason);
          const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
          if (held.ok) {
            pipeline = held.value;
            steps.push(
              `"${stage.name}" left ${questions.length} question(s) in its plan — held for you.`,
            );
            this.logger.warn(`Harness [${task.name}] ${stage.name}: ${reason}`);
          }
        }
      }
    }

    // The same shape again, for the one artefact of a promotion stage that leaves no
    // trace in git. A stage told to open a pull request and report its URL can push
    // the branch, write a full account of what it did, and never open the pull
    // request — which is what happened on RU-550, and was discovered a stage later as
    // an exit code about commits not being on UAT. Read from the pipeline as it now
    // stands, so it sees every subtask's reply including this one's.
    if (reply.ok) {
      const settled = pipeline.stages.find((s) => s.id === stage.id);
      if (
        settled &&
        !settled.subtasks.some((s) => s.status === "pending" || s.status === "active") &&
        missingPullRequestUrl(settled)
      ) {
        pipeline = recordStageBlocked(pipeline, stage.id, MISSING_PULL_REQUEST_REASON);
        const held = holdStageForFindings(pipeline, stage.id, new Date().toISOString());
        if (held.ok) {
          pipeline = held.value;
          steps.push(`"${stage.name}" reported no pull request URL — held for you.`);
          this.logger.warn(
            `Harness [${task.name}] ${stage.name} promotes by pull request and reported ` +
              "no pull request URL. Holding rather than passing: check one was opened, " +
              "because the stage after it is a human merging it.",
          );
        }
      }
    }

    if (reply.ok && (handoffText || reply.text.trim())) {
      pipeline = recordHandoff(
        pipeline,
        stage.id,
        // The distilled block when the stage wrote one, the whole reply when it
        // did not. The fallback is not a formality: the block is asked for in a
        // prompt, so a stage that ignores the instruction, or one whose route
        // enabled handoff after it ran, must still carry something forward rather
        // than silently contributing nothing to every stage after it.
        handoffText ? distilHandoff(handoffText) : reply.text,
        new Date().toISOString(),
      );
    }

    let saved = await this.save(task, pipeline);

    // After the save, because the claim record is written through the repository: the
    // state file is read-modify-write, so a second in-memory copy of the task would
    // overwrite whichever of the two was written first.
    if (claimsBefore) {
      const outcome = await this.claims!.recordStageClaims(saved.id, claimsBefore, {
        stageId: stage.id,
        at: new Date().toISOString(),
        commands: reply.activity?.commands ?? [],
      });
      if (outcome.claimed.length > 0) {
        saved = (await this.repository.get(saved.id)) ?? saved;
        steps.push(
          `"${stage.name}" created ${outcome.claimed.length} worktree(s), now recorded ` +
            `against this task: ${outcome.claimed.map((c) => c.path).join(", ")}.`,
        );
      }
      // Held rather than reported in passing. Two tasks promoting through one worktree
      // interleave their cherry-picks, and the previous warning was an agent noticing it
      // in `git worktree list` and mentioning it in prose that nothing read.
      if (outcome.conflicts.length > 0) {
        const listed = outcome.conflicts
          .map((conflict) => `${conflict.path} (${conflict.reason})`)
          .join("; ");
        const held = holdStageForFindings(
          recordStageBlocked(
            saved.pipeline!,
            stage.id,
            `worktree conflict: ${listed}`,
          ),
          stage.id,
          new Date().toISOString(),
        );
        if (held.ok) saved = await this.save(saved, held.value);
        steps.push(`"${stage.name}" overlaps another task's worktree — held for you: ${listed}.`);
      }
    }

    return { task: saved, failed: !reply.ok, reason };
  }

  /**
   * Records the worktrees that appeared while a subtask ran.
   *
   * Called on **every** way out of a subtask, not only the one where the reply was
   * interpreted. The worktrees exist the moment the session ends, whatever we then
   * decide the reply meant — and a promotion stage is the likeliest of all stages to
   * exit early, because asking a question, being stopped, or having a `git push`
   * refused is routine for one. Recorded only on the path that read the reply, a
   * `promote/*` tree created by a stage that then asked something was never attached
   * to anything: not cleaned up, not claimed, and listed forever as an orphan the
   * harness itself had made.
   *
   * Must run *after* the caller has saved its own pipeline changes. The claim is
   * written through the repository, and the state file is read-modify-write, so an
   * in-memory task saved afterwards would drop the claim again.
   *
   * Conflicts are only *held* on the main path, where the stage's outcome is being
   * decided anyway. Here they are logged: the stage has not passed, so the next run
   * re-snapshots and holds it then, and holding a stage that is simultaneously
   * waiting on a question would be two contradictory reasons to stop.
   */
  private async recordAppearedWorktrees(
    task: TaskWorkspace,
    claimsBefore: WorktreeSnapshot | undefined,
    stage: TaskStage,
    steps: string[],
    commands: readonly string[],
  ): Promise<TaskWorkspace> {
    if (!claimsBefore || !this.claims) return task;

    const outcome = await this.claims.recordStageClaims(task.id, claimsBefore, {
      stageId: stage.id,
      at: new Date().toISOString(),
      commands,
    });
    if (outcome.claimed.length === 0 && outcome.conflicts.length === 0) return task;

    if (outcome.claimed.length > 0) {
      steps.push(
        `"${stage.name}" created ${outcome.claimed.length} worktree(s), now recorded ` +
          `against this task: ${outcome.claimed.map((c) => c.path).join(", ")}.`,
      );
    }
    for (const conflict of outcome.conflicts) {
      this.logger.warn(
        `Harness [${task.name}] "${stage.name}" overlaps another task at ` +
          `${conflict.path} (${conflict.reason}). It will be held when this stage runs again.`,
      );
    }
    return (await this.repository.get(task.id)) ?? task;
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



/**
 * Whether this is the last subtask of its stage still to resolve.
 *
 * Decides when a stage's verification runs. A stage's check certifies the stage, so
 * running it per subtask would pay for the same build several times to learn the
 * same thing — and a check run halfway through a split stage would fail on work
 * that was always going to be finished by the next subtask.
 */
function isLastUnresolved(stage: TaskStage, subtaskId: string): boolean {
  return !stage.subtasks.some(
    (subtask) =>
      subtask.id !== subtaskId &&
      (subtask.status === "pending" || subtask.status === "active"),
  );
}

/**
 * Turns the block a stage wrote into the text later stages are given.
 *
 * The parse-and-reformat is not cosmetic. What is carried forward has a hard
 * ceiling, and the previous behaviour — cut the reply at the limit — kept whatever
 * happened to come first, which in a reply written for a human reader is the
 * restatement and the context. Re-emitting the parsed sections in priority order
 * means a squeeze drops the file list and the already-done items, and keeps the
 * next step and the decisions that a later stage genuinely cannot re-derive.
 *
 * A block that parsed into nothing recognisable is passed through as written. The
 * parser is tolerant by design, and a stage that wrote a useful paragraph under no
 * heading at all should not have it discarded for being the wrong shape.
 */
function distilHandoff(block: string): string {
  const { handoff, structured } = parseHandoff(block);
  if (!structured || isEmptyHandoff(handoff)) return block;
  return formatHandoffBrief(handoff, {
    omitHeader: true,
    // Under the ceiling `recordHandoff` applies, so the priority-ordered drop
    // above decides what goes rather than a blind cut at the boundary.
    maxChars: MAX_HANDOFF_CHARS - 100,
  });
}

/**
 * What the stage said before this correction, for the correction to start from.
 *
 * Every subtask except the correction itself, including earlier corrections — a
 * stage fixed twice has to see the first fix, or the second undoes it.
 *
 * This is the whole economy of a correction: a re-run is expensive because it
 * re-derives what the stage already worked out, and this is that working-out.
 */
function previousReport(stage: TaskStage, exceptSubtaskId: string): string {
  return stage.subtasks
    .filter((subtask) => subtask.id !== exceptSubtaskId)
    .map((subtask) =>
      subtask.reply?.trim()
        ? stage.subtasks.length > 2
          ? `**${subtask.title}:** ${subtask.reply.trim()}`
          : subtask.reply.trim()
        : "",
    )
    .filter(Boolean)
    .join("\n\n");
}

/** Folds a verification into a subtask's activity, creating one if it had none. */
function withVerification(
  activity: SubtaskActivity | undefined,
  command: string,
  outcome: CommandOutcome,
): SubtaskActivity {
  const header = `$ ${redactSecrets(command)}   [verification, exit ${outcome.exitCode}]`;
  const block = outcome.output ? `${header}\n${outcome.output}` : header;
  return {
    ...(activity ?? {}),
    commands: [...(activity?.commands ?? []), redactSecrets(command)],
    output: [activity?.output, block].filter(Boolean).join("\n\n"),
    // A command that could not start is the session's problem, not the work's, so it
    // goes where session-level failures go rather than reading as a failed build.
    errors: outcome.spawnError
      ? [...(activity?.errors ?? []), `verification could not run: ${outcome.spawnError}`]
      : activity?.errors,
  };
}

/**
 * The route as a stage should see it: every stage in order, with this one marked.
 *
 * Skipped and passed stages are included. A stage that already ran is why something is
 * *not* outstanding, and omitting it invites the reader to raise work that is done.
 */
function routeOutline(
  pipeline: TaskPipeline | undefined,
  stageId: string,
): { id: string; name: string; summary: string }[] | undefined {
  if (!pipeline || pipeline.stages.length === 0) return undefined;
  if (!pipeline.stages.some((stage) => stage.id === stageId)) return undefined;

  // Intentionally independent of which stage is asking, so every stage of a task gets
  // the same bytes and shares one cached prefix. The reader's position is added after
  // the list, by `routePosition`.
  return pipeline.stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    summary: summariseIntent(stage.intent),
  }));
}
