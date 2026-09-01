import { Result, ok, err } from "../utilities/result";
import {
  ChecklistItem,
  DenialItem,
  DiscardedRun,
  PlanStepRecord,
  QuestionItem,
  Subtask,
  DeferralItem,
  MAX_DEFERRAL_CHARS,
  StageAssessment,
  SubtaskActivity,
  TaskPipeline,
  TaskStage,
  truncateHandoff,
} from "./taskPipeline";
import {
  RouteDefinition,
  RouteStageDefinition,
  StageKind,
  producesChecklist,
} from "./taskRoute";
import { PlanStep, StepAccount } from "./planSteps";
import { amendmentIsUnreachable } from "./amendmentReach";
import { hasUsage, stageUsage, subtasksUsage } from "./stageUsage";
import {
  amendmentTitle,
  UpstreamCorrection,
  upstreamAmendmentNote,
} from "./upstreamAmendment";
import { ownedByPendingStage, ownedByStageResolution } from "./deferralOwnership";
import { itemsForGate } from "./checklistScope";
import {
  InterventionKind,
  InterventionRecord,
  appendIntervention,
} from "./interventions";
import {
  ReviewRule,
  RuleMatch,
  evaluateRules,
  ruleStageDefinition,
} from "./reviewRules";

/**
 * The pipeline engine. Every function here is pure and immutable: state in,
 * new state out, no clocks and no I/O. Timestamps arrive as parameters so
 * transitions are deterministic under test.
 *
 * The engine never runs anything. `nextAction` reports what should happen next
 * and callers report back what did happen — that split is what keeps the
 * orchestration testable in isolation from the agent providers.
 */

export type PipelineError =
  | { kind: "unknownStage"; message: string }
  | { kind: "unknownSubtask"; message: string }
  | { kind: "notSplittable"; message: string }
  | { kind: "notCorrectable"; message: string }
  | { kind: "emptySplit"; message: string }
  | { kind: "alreadyPlanned"; message: string }
  | { kind: "alreadyResolved"; message: string }
  | { kind: "notAwaitingApproval"; message: string }
  | { kind: "checklistIncomplete"; message: string; outstanding: number }
  | { kind: "unknownChecklistItem"; message: string }
  | { kind: "unknownDeferral"; message: string }
  | {
      kind: "planStepsUnaccounted";
      message: string;
      /** The step numbers nobody has said anything about. */
      steps: number[];
    }
  | { kind: "noPendingQuestion"; message: string }
  | { kind: "unknownQuestion"; message: string };

/** What the harness should do next. Exhaustive by construction. */
export type NextAction =
  /** A splittable stage has no subtasks yet; ask a planning agent to split it. */
  | { kind: "split"; stage: TaskStage }
  /** Start an agent session for this subtask. */
  | { kind: "run"; stage: TaskStage; subtask: Subtask }
  /** A subtask is already in flight; wait for it to report back. */
  | { kind: "running"; stage: TaskStage; subtask: Subtask }
  /** Every subtask resolved; a human must approve before advancing. */
  | { kind: "awaitApproval"; stage: TaskStage }
  /** A stage failed. The route cannot proceed until it is retried or skipped. */
  | { kind: "blocked"; stage: TaskStage }
  /**
   * A stage that ships is next, and work every earlier stage declined has no
   * owner. Distinct from `blocked`: nothing has failed and nothing needs
   * retrying — a human has to say who owns the work, or that nobody need.
   */
  | { kind: "deferredWork"; stage: TaskStage; items: DeferralItem[] }
  /** No stages left. */
  | { kind: "done" };

/**
 * Adds one intervention to the pipeline, as a spreadable fragment.
 *
 * Returns nothing when the caller gave no timestamp, so a call site that has not
 * been given a clock records nothing rather than an event dated `undefined`. The
 * count is a measurement, and a measurement that invents its own data is worse
 * than one that admits a gap — but the gap is per call site and visible in the
 * code, not per event and invisible in the data.
 */
function counted(
  pipeline: TaskPipeline,
  record: { kind: InterventionKind; stageId?: string },
  at: string | undefined,
): { interventions?: InterventionRecord[] } {
  if (!at) return {};
  return {
    interventions: appendIntervention(pipeline.interventions, { ...record, at }),
  };
}

/** Instantiates a route into fresh pipeline state. */
export function createPipeline(route: RouteDefinition): TaskPipeline {
  return {
    routeId: route.id,
    routeLabel: route.label,
    stages: route.stages.map((definition) => createStage(definition)),
  };
}

/**
 * A pending stage from a route definition.
 *
 * Exported so `stageRefresh` can add a stage a route gained after a task was created,
 * building it exactly as `createPipeline` would rather than a near-copy that drifts.
 */
export function stageFromDefinition(
  definition: RouteStageDefinition,
  addedByRule?: string,
): TaskStage {
  return createStage(definition, addedByRule);
}

function createStage(
  definition: RouteStageDefinition,
  addedByRule?: string,
  rulePaths?: TaskStage["rulePaths"],
): TaskStage {
  return {
    id: definition.id,
    name: definition.label,
    kind: definition.kind,
    status: "pending",
    intent: definition.intent,
    addedByRule,
    ...(rulePaths ? { rulePaths } : {}),
    model: definition.model,
    splittable: definition.splittable,
    requiresApproval: definition.gate === "approval",
    ...(definition.authority ? { authority: definition.authority } : {}),
    ...(definition.autoRepair ? { autoRepair: true } : {}),
    ...(definition.mayMutateRoute ? { mayMutateRoute: true } : {}),
    ...(definition.sendBackTo && definition.sendBackTo.length > 0
      ? { sendBackTo: [...definition.sendBackTo] }
      : {}),
    ...(definition.handoff ? { handoff: true } : {}),
    ...(definition.mayChangeBranch ? { mayChangeBranch: true } : {}),
    ...(definition.verify ? { verify: definition.verify } : {}),
    ...(definition.planFile ? { planFile: definition.planFile } : {}),
    ...(definition.planOutput ? { planOutput: definition.planOutput } : {}),
    ...(definition.checklistScope
      ? { checklistScope: definition.checklistScope }
      : {}),
    ...(definition.checklistAudience
      ? { checklistAudience: definition.checklistAudience }
      : {}),
    ...(definition.requiresPullRequest ? { requiresPullRequest: true } : {}),
    ...(definition.requiredMcpServers && definition.requiredMcpServers.length > 0
      ? { requiredMcpServers: [...definition.requiredMcpServers] }
      : {}),
    // A non-splittable stage is its own single unit of work. Synthesizing that
    // subtask up front means every runnable stage has the same shape, so the
    // engine needs no special case for unsplit work.
    subtasks: definition.splittable
      ? []
      : [
          {
            id: `${definition.id}-1`,
            title: definition.label,
            prompt: definition.intent,
            workflow: definition.workflow,
            status: "pending",
          },
        ],
  };
}

/**
 * Reports the next thing to do, scanning stages in route order. Resolved stages
 * are skipped; the first unresolved one decides the answer.
 */
export function nextAction(pipeline: TaskPipeline): NextAction {
  for (const stage of pipeline.stages) {
    if (stage.status === "passed" || stage.status === "skipped") continue;
    if (stage.status === "failed") return { kind: "blocked", stage };
    if (stage.status === "awaiting-approval") {
      return { kind: "awaitApproval", stage };
    }

    // Checked before the stage is allowed to start, and only for a stage that
    // ships. A deferral is not a defect — most are correct, and the stage that
    // raised one was right to stay in its lane — so holding every stage on one
    // would stop routes constantly. What must not happen is the one that did:
    // work declined by every stage in turn, discovered by a live publish.
    if (stage.kind === "deployment") {
      const items = outstandingDeferrals(pipeline);
      if (items.length > 0) return { kind: "deferredWork", stage, items };
    }

    if (stage.splittable && stage.subtasks.length === 0) {
      return { kind: "split", stage };
    }

    const active = stage.subtasks.find((s) => s.status === "active");
    if (active) return { kind: "running", stage, subtask: active };

    const pending = stage.subtasks.find((s) => s.status === "pending");
    if (pending) return { kind: "run", stage, subtask: pending };

    // Unresolved stage with no unresolved subtasks should be impossible:
    // finishSubtask settles the stage as soon as the last subtask resolves.
    return { kind: "blocked", stage };
  }
  return { kind: "done" };
}

export interface AppliedRules {
  pipeline: TaskPipeline;
  /** Stages appended by this call. Empty when the diff required nothing new. */
  added: TaskStage[];
  /** Every rule that matched, including ones whose stage was already present. */
  matches: RuleMatch[];
  /**
   * Deployment stages that had already run by the time these reviews were added.
   *
   * A review's whole purpose is to be in front of a deployment, and where one
   * cannot be, that is a material fact rather than a detail of ordering: the review
   * can no longer prevent what has already happened, and it may be running against
   * a tree a promotion stage moved. Reported so the caller can say so, because the
   * placement otherwise looks routine.
   */
  deployedAlready: TaskStage[];
}

/**
 * Appends the review stages a diff requires, inserting them before the terminal
 * human-verification gate so conditional reviews always precede sign-off.
 *
 * Safe to call repeatedly as the diff grows: a stage already present is never
 * added twice, and existing stages keep their state. That idempotence is the
 * point — the harness re-evaluates rules whenever the changed-file set moves,
 * and a stage already reviewed must not be reset.
 *
 * When a route has no human-verification stage (an adopted ad-hoc pipeline, for
 * instance) the new stages are appended at the end.
 */
export function applyRules(
  pipeline: TaskPipeline,
  changedPaths: readonly string[],
  rules?: readonly ReviewRule[],
): AppliedRules {
  const matches = evaluateRules(changedPaths, rules);
  const existing = new Set(pipeline.stages.map((s) => s.id));

  const added: TaskStage[] = [];
  for (const match of matches) {
    const definition = ruleStageDefinition(match.rule);
    if (existing.has(definition.id)) continue;
    existing.add(definition.id);
    added.push(
      createStage(definition, match.rule.reason, {
        pathPattern: match.rule.pathPattern,
        ...(match.rule.exceptPattern ? { exceptPattern: match.rule.exceptPattern } : {}),
      }),
    );
  }

  if (added.length === 0) {
    return { pipeline, added, matches, deployedAlready: [] };
  }

  // Placed one at a time, because where a rule stage belongs depends on what it is:
  // a static review goes in front of the deployment, a behaviour review that writes
  // a checklist goes after it. A single splice point for all of them put a runtime
  // checklist in front of the DEV push it was meant to be exercised against.
  const stages = [...pipeline.stages];
  let at = stages.length;
  for (const stage of added) {
    const index = ruleInsertionIndex(stages, stage.kind);
    stages.splice(index, 0, stage);
    at = Math.min(at, index);
  }

  // Deployments already behind the insertion point. There is nowhere earlier to put
  // these reviews — a pending stage cannot be placed before one that has run, where
  // the order would no longer describe anything that happened — so the answer is to
  // say so rather than to file them quietly and look normal.
  const deployedAlready = pipeline.stages
    .slice(0, at)
    .filter(
      (stage) =>
        stage.kind === "deployment" &&
        (stage.status === "passed" || stage.status === "awaiting-approval"),
    );

  return { pipeline: { ...pipeline, stages }, added, matches, deployedAlready };
}

/**
 * Where a rule's reviews belong: as soon as the work exists, and always before
 * anything irreversible happens.
 *
 * This was the first `humanVerification` stage, which in a route that deploys to a
 * dev environment before a human signs off put the reviews *after the deployment*.
 * A review that checks whether an object is in the right layer and safe to run is
 * worthless once it has already run somewhere — and it is precisely the kind of
 * route the harness is for, so this was wrong for the main case.
 *
 * The barrier is therefore the first stage that ships work or hands it to a
 * person. Only **unresolved** stages count: a deployment that has already happened
 * cannot be got in front of, and inserting a pending review before a stage that
 * has passed would place it in the past, where the order no longer describes
 * anything that happened.
 */
export function ruleInsertionIndex(
  stages: readonly TaskStage[],
  kind?: StageKind,
): number {
  // A checklist is a list of things for a person to *exercise*, so the stage that
  // writes one is worthless until the work is running somewhere. It is the exact
  // inverse of a static review, and putting both in front of the deployment made the
  // checklist unusable: it was raised before anything reached DEV, and holding the
  // route on items nobody could yet test is a gate that can only be clicked past.
  //
  // The barrier reasoning does not apply to it either. "Before anything irreversible"
  // protects a review that says whether an object is safe to run; a behaviour review
  // asks how it behaved, which is a question with no answer until it has run.
  // Immediately before the gate that will *read* the checklist, which is the only
  // position that is right on every route shape.
  //
  // "After the first deployment" was the previous rule, and it broke as soon as a route
  // had two kinds of deployment. On `report-change` the first one lands the branch in
  // source control and puts nothing in any environment — its own successor stage says so:
  // "landing on DEV merges the branch, it does not run the scripts". So the checklist was
  // written while the change was half-live, asking a human to exercise behaviour whose
  // SQL was not yet deployed. One `StageKind` was covering two different acts, and
  // counting deployments could not tell them apart.
  //
  // The consuming gate can. A checklist exists to be worked through at a verification
  // gate, so writing it just before that gate puts it after everything that makes the
  // change observable, whatever those stages happen to be called.
  if (kind && producesChecklist(kind)) {
    const gate = stages.findIndex(
      (stage) =>
        stage.kind === "humanVerification" &&
        stage.status !== "passed" &&
        stage.status !== "skipped",
    );
    if (gate !== -1) return Math.max(gate, firstUnresolvedIndex(stages));
    // No gate left to read it, so anchor on the first deployment as before. Deliberately
    // unchanged: that rule is right when nothing consumes the checklist — the change is
    // observable from the first deployment onwards — and narrowing this fix to the
    // gate-anchored case is what keeps every other route's behaviour identical.
    const deployed = stages.findIndex((stage) => stage.kind === "deployment");
    if (deployed !== -1) return Math.max(deployed + 1, firstUnresolvedIndex(stages));
  }

  const found = stages.findIndex(
    (stage) =>
      (stage.status === "pending" || stage.status === "awaiting-approval") &&
      (stage.kind === "deployment" || stage.kind === "humanVerification"),
  );
  const barrier = found === -1 ? stages.length : found;

  // The barrier says where a review may run no later than. On its own it also placed
  // every review as late as it legally could, which turned out to be the expensive
  // half of the decision.
  //
  // A send-back discards the target stage and everything after it, so every stage
  // standing between the work and the review of it is a stage thrown away and re-run
  // when the review finds something. On a real route that meant a SQL review running
  // after the code review and the DEV landing plan, finding a double-counting join,
  // and costing both of them — three times, because the first two send-backs had
  // nowhere better to go.
  //
  // So: as early as the review can actually run, which is once the work exists.
  let earliest = 0;
  for (let index = 0; index < barrier; index += 1) {
    if (stages[index].kind === "implementation") earliest = index + 1;
  }

  // Never into the past. A pending review spliced in front of stages that already
  // ran would claim an order that never happened — the same reason the barrier only
  // counts unresolved stages.
  const unresolved = firstUnresolvedIndex(stages);
  const floor = unresolved === stages.length ? barrier : unresolved;

  return Math.min(barrier, Math.max(earliest, floor));
}

/** Where the route currently is; `stages.length` when everything has resolved. */
function firstUnresolvedIndex(stages: readonly TaskStage[]): number {
  const index = stages.findIndex(
    (stage) =>
      stage.status === "pending" ||
      stage.status === "active" ||
      stage.status === "awaiting-approval",
  );
  return index === -1 ? stages.length : index;
}

/**
 * Records what a stage concluded, for the stages after it.
 *
 * The counterweight to subtask-per-session. The fresh session is what makes a
 * review independent and a stage cheap to reason about, and that is worth paying
 * for — but paying for it *twice*, by making every stage re-derive what the last
 * one had just established, buys nothing. This carries the conclusion and nothing
 * else: not the transcript, not the output, not the files.
 *
 * Only stages the route marks `handoff` contribute, so a project decides where
 * continuity is worth the prompt space. Re-recording a stage replaces its earlier
 * entry rather than appending, so a re-run does not leave two versions of the
 * truth for a later stage to choose between.
 */
export function recordHandoff(
  pipeline: TaskPipeline,
  stageId: string,
  text: string,
  at: string,
): TaskPipeline {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage?.handoff) return pipeline;

  const trimmed = truncateHandoff(text);
  if (!trimmed) return pipeline;

  const others = (pipeline.handoffs ?? []).filter((h) => h.stageId !== stageId);
  return {
    ...pipeline,
    handoffs: [
      ...others,
      { stageId, stageName: stage.name, text: trimmed, at },
    ],
  };
}

/**
 * Handoffs from stages *before* a given one, in route order.
 *
 * Ordered by the route rather than by when they were recorded, because a reader —
 * human or model — follows the sequence of the work, and a re-run would otherwise
 * put an early stage's conclusion last.
 */
export function handoffsBefore(
  pipeline: TaskPipeline,
  stageId: string,
): { stageName: string; text: string }[] {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index <= 0) return [];
  const order = new Map(pipeline.stages.map((stage, at) => [stage.id, at]));
  return (pipeline.handoffs ?? [])
    .filter((handoff) => {
      const at = order.get(handoff.stageId);
      return at !== undefined && at < index;
    })
    .sort((a, b) => (order.get(a.stageId) ?? 0) - (order.get(b.stageId) ?? 0))
    .map((handoff) => ({ stageName: handoff.stageName, text: handoff.text }));
}

/**
 * Holds a review stage that found something, even though it ran successfully.
 *
 * The gap this closes is the oldest one in the harness: a stage's outcome was
 * *self-reported*, meaning "the session ended without error" — so a review that
 * came back with fourteen critical findings passed exactly like a clean one, and
 * the route carried on to deploy. The findings were parsed, displayed, and acted
 * on by nobody.
 *
 * Held rather than failed, deliberately. A failure says the stage could not do its
 * job; this stage did its job well — it found problems. What must not happen is the
 * route proceeding as though it had not, and a human is the right decider: some
 * findings are worth fixing before deploying, some are not.
 */
/**
 * Records what a review concluded, separately from what the route did about it.
 *
 * Kept because the verdict line is stripped out of the reply before anyone reads
 * it, and without this a review that stated `block` but whose findings did not
 * parse would leave a stage held for approval with nothing on screen explaining
 * why — which is exactly how a blocking review came to look like a clean one.
 */
export function recordStageVerdict(
  pipeline: TaskPipeline,
  stageId: string,
  verdict: "pass" | "block",
): Result<TaskPipeline, PipelineError> {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) {
    return err({ kind: "unknownStage", message: `No stage ${stageId}` });
  }
  const stages = [...pipeline.stages];
  stages[index] = { ...stages[index], verdict };
  return ok({ ...pipeline, stages } as TaskPipeline);
}

/**
 * Records that a stage's declared check actually ran, and what it returned.
 *
 * The exit code is kept even when it is zero: absence has to mean "no check ran",
 * or the record cannot distinguish a passing build from one nobody attempted.
 */
/**
 * Counts an operator interjection against the stage it interrupted.
 *
 * Recorded when the message is *delivered*, never when it is typed: an
 * interjection that never reached a session — the stage finished first, the run
 * was stopped — cost the operator a sentence and cost the route nothing, and
 * counting it would inflate the one number the harness is judged on with events
 * that did not happen.
 */
export function recordInterjection(
  pipeline: TaskPipeline,
  stageId: string | undefined,
  at: string,
): TaskPipeline {
  return { ...pipeline, ...counted(pipeline, { kind: "interjection", stageId }, at) };
}

export function recordVerification(
  pipeline: TaskPipeline,
  stageId: string,
  verification: { command: string; exitCode: number; at: string },
): Result<TaskPipeline, PipelineError> {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) {
    return err({ kind: "unknownStage", message: `No stage ${stageId}` });
  }
  const stages = [...pipeline.stages];
  stages[index] = { ...stages[index], verification };
  return ok({ ...pipeline, stages } as TaskPipeline);
}

export function holdStageForFindings(
  pipeline: TaskPipeline,
  stageId: string,
  at: string,
): Result<TaskPipeline, PipelineError> {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) {
    return err({ kind: "unknownStage", message: `No stage ${stageId}` });
  }
  const stage = pipeline.stages[index];
  // Only a stage that just settled clean. One already awaiting approval is where
  // this wants it, and one that failed has a louder problem.
  if (stage.status !== "passed") return ok(pipeline);

  const stages = [...pipeline.stages];
  stages[index] = {
    ...stage,
    status: "awaiting-approval",
    finishedAt: undefined,
  };
  return ok({ ...pipeline, stages, currentStage: stageId, updatedAt: at } as TaskPipeline);
}

/** A subtask as proposed by a planning agent, before the engine assigns ids. */
export interface SubtaskSpec {
  title: string;
  prompt: string;
  workflow?: string;
}

/**
 * Fills a splittable stage with the subtasks a planning agent produced. Rejects
 * re-planning a stage that already has subtasks — retries go through
 * `retryStage`, which clears them explicitly.
 */
/**
 * Adds a targeted fix to a stage that has already run, instead of discarding it.
 *
 * The gear the harness was missing. Every correction was stage-granular: a one-line
 * cast error and a fundamentally wrong implementation both cost a full re-run of the
 * stage from cold — on one real route, $12.48 and 44 minutes and 15M tokens of
 * re-derived context, to change a type. So the only repair tool was demolition, and
 * the rational response to a review finding became "don't act on it".
 *
 * What makes this cheap is what it *keeps*. The stage's existing subtasks, replies
 * and activity all stay: the correction session is given the stage's own previous
 * report and told what is wrong with it, so it does not re-plan, re-read the ticket
 * or rediscover the codebase. The cost of the original run stays on the record too,
 * which a revert would have erased.
 *
 * Later stages are still re-opened, exactly as a revert re-opens them — they ran
 * against output that has just changed, and their evidence is no longer about this
 * work. That is affordable precisely because those stages are the cheap ones: on the
 * route this came from, four implementation stages carried the cost and the other
 * sixteen were gates, promotions and reviews.
 */
/**
 * Whether a stage has produced anything a correction could act on.
 *
 * Exported so the tree's context value and `correctStage` cannot disagree about it.
 * They did: the menu offered the action on a `passed`, `failed` or `awaiting-approval`
 * stage, and a correction sets its stage back to `pending` — so filing one hid the
 * command that would file the next, which is precisely the batching the confirmation
 * dialog invites you to do. Status was never the right question; having produced
 * something to correct is.
 */
export function isCorrectable(stage: TaskStage): boolean {
  return stage.subtasks.some((subtask) => subtask.reply || subtask.activity);
}

/**
 * The lowest amendment number this stage is not already using.
 *
 * Keyed on the ids actually present, which is the only thing that makes the result
 * unique — a count says how many there are, not which numbers they took.
 */
function freeAmendmentOrdinal(stage: TaskStage): number {
  const taken = new Set(stage.subtasks.map((sub) => sub.id));
  let ordinal = 1;
  while (taken.has(`${stage.id}-amend-${ordinal}`)) ordinal += 1;
  return ordinal;
}

/**
 * Re-opens every stage after `index`, and books what that threw away.
 *
 * Shared by `correctStage` and `undoCorrection` because the rule is one rule, and
 * having it written twice is exactly how the two came to disagree: filing a
 * correction re-opened the stages after it — they ran against output that had just
 * changed — and withdrawing one did not, though it changes that stage's output in
 * precisely the same way. A plan corrected, applied by the stages after it, and then
 * un-corrected left those stages recorded as passed against a plan that no longer
 * existed, which is the failure both halves exist to prevent, reached backwards.
 *
 * Returns the re-opened stages positionally, so a caller can splice its own target
 * stage in without having to restate what re-opening means.
 */
function reopenAfter(
  pipeline: TaskPipeline,
  index: number,
  at: string,
  reason: string,
  /**
   * The correction that caused this. When given, a later stage that has produced
   * something is **amended** rather than wiped: its replies and activity stay, and it
   * gets a subtask telling it what changed upstream. See `domain/upstreamAmendment.ts`
   * for the measurement — 61% of a 2.5-hour window was downstream stages re-running
   * cold — and for why nothing is skipped by doing this.
   *
   * Optional so a caller that really does want demolition still gets it. That is
   * `revertToStage`'s business, and it stays a deliberate, human-chosen act.
   */
  upstream?: UpstreamCorrection,
): { later: TaskStage[]; discarded: DiscardedRun[] } {
  // Captured before the map below clears it. Both callers keep their own stage, so
  // every entry here is collateral by construction — and it was going unrecorded,
  // which is precisely why "a correction is cheap because the stages after it are
  // the cheap ones" was an assertion nobody could check.
  // An amended stage keeps everything it produced, so nothing about it was discarded
  // and the ledger must not say otherwise. This is the whole claim being made —
  // `discarded` is the number that says how much a correction cost, and booking
  // retained work into it would report the saving as if it had never happened.
  const amendable = (stage: TaskStage) => !!upstream && isCorrectable(stage);

  const discarded: DiscardedRun[] = pipeline.stages
    .slice(index + 1)
    .filter((s) => !amendable(s))
    .map((s) => ({ stage: s, totals: stageUsage(s) }))
    // Keyed on there being a number to record rather than on `startedAt`: a stage
    // whose cost was captured without a start time is exactly the entry this ledger
    // exists for, and a pending stage after the target is re-opened too — a zero for
    // it would fill the ledger with work that never happened.
    .filter(({ totals }) => hasUsage(totals))
    .map(({ stage: s, totals }) => ({
      stageId: s.id,
      stageName: s.name,
      at,
      reason,
      collateral: true,
      costUsd: totals.costUsd,
      tokens: totals.tokens,
      elapsedMs: totals.elapsedMs,
      sessions: totals.measured + totals.unmeasured,
    }));

  const later: TaskStage[] = [];
  pipeline.stages.forEach((s, i) => {
    if (i <= index) return;

    // Cleared either way, because all of it certified the version that just moved:
    // a verdict, an exit code, a checklist of behaviours somebody observed, and a
    // per-step account of a plan that has changed. Keeping any of it would leave the
    // route holding evidence about work that no longer exists — which is the failure
    // re-opening exists to prevent, and the half that amendment must not soften.
    const cleared = {
      ...s,
      status: "pending" as const,
      finishedAt: undefined,
      checklist: undefined,
      planSteps: undefined,
      verification: undefined,
      verdict: undefined,
      blocked: undefined,
    };

    if (amendable(s)) {
      // Snapshotted so withdrawing the upstream correction can put this stage back
      // too. Before amendment there was nothing to put back — the replies were gone —
      // which is why `CorrectionUndo` said it covered only the corrected stage's own
      // settlement.
      const undo = {
        status: s.status,
        finishedAt: s.finishedAt,
        verdict: s.verdict,
        verification: s.verification,
        blocked: s.blocked,
      };

      // An amendment for this same upstream stage that has not run yet absorbs this
      // correction instead of being appended beside it. A round that produced nothing
      // is not a round: both notes describe deltas against the same unrun base output,
      // so delivered separately they cost a session each to re-read it. Unbounded, that
      // is what exhausted the step limit — eight corrections of two stages left 69
      // never-run amendments across eight downstream stages, 77 sessions before the
      // route could reach a gate that would have stopped it.
      //
      // Restricted to the *same* upstream stage so `withdrawAmendments` needs no
      // change: it matches on `upstream.stageId`, and a subtask that absorbed two
      // stages' corrections could not be attributed to either. It keeps the earliest
      // `at` and `undo` with it, which is the settlement `withdrawAmendments` already
      // reaches for — so withdrawing the later of two absorbed corrections restores
      // further back than that one correction alone. Honest here, and for the same
      // reason absorbing is safe at all: no work happened between them.
      //
      // Requires `findings`, so this only ever absorbs an amendment this version
      // wrote. `finding` on an older one is the composed note, and nesting one note
      // inside another would hand the stage two sets of instructions — the failure
      // `HANDOFF`-beside-`VERDICT` already taught this codebase to avoid.
      const absorbing = [...s.subtasks]
        .reverse()
        .find(
          (sub) =>
            sub.status === "pending" &&
            !sub.reply &&
            !sub.activity &&
            sub.correction?.upstream?.stageId === upstream!.stageId &&
            sub.correction.upstream.findings !== undefined,
        );

      const note = (earlier: string[]) => upstreamAmendmentNote(upstream!, earlier);

      const amend = (existing: Subtask | undefined): Subtask => {
        const earlier = existing?.correction?.upstream?.findings ?? [];
        const findings = [...earlier, upstream!.finding];
        // Counting amendments was not enough to number the next one, because
        // `withdrawAmendments` *removes* them: withdraw the second and third of four and
        // the count drops to two, so the next amendment is numbered three — beside a
        // surviving four — and the one after that collides with it outright. Two
        // subtasks then share an id, and `finishSubtask` matches by id, so it settles
        // the first and leaves the pending one pending forever. The stage never
        // advances, and the advance loops on it until it hits the step limit, which is
        // exactly how `Purchases vs Sales Phase 3` came to be stuck across six stages at
        // once with an unexplained exhaustion behind it.
        //
        // So the number is chosen against what exists rather than against how many
        // exist. Kept as the smallest free ordinal rather than max-plus-one, since the
        // number is shown to a reader as "Amend for X (3)" and skipping numbers because
        // a withdrawn round once used them tells them nothing true.
        const ordinal = existing ? undefined : freeAmendmentOrdinal(s);
        return {
          ...existing,
          id: existing?.id ?? `${s.id}-amend-${ordinal}`,
          title: existing?.title ?? amendmentTitle(upstream!.stageName, ordinal!),
          // The note is the *finding*, because that is what `correctionPrompt`
          // reads for a correction subtask; `prompt` goes unused on this path and
          // is kept in step only so a reader of the state file is not misled.
          prompt: note(earlier),
          status: "pending" as const,
          correction: {
            finding: note(earlier),
            // The earliest correction's timestamp and settlement are kept, because
            // that is the one whose withdrawal has to restore this stage.
            at: existing?.correction?.at ?? at,
            upstream: {
              stageId: upstream!.stageId,
              stageName: upstream!.stageName,
              findings,
            },
            undo: existing?.correction?.undo ?? undo,
          },
        };
      };

      later[i] = {
        ...cleared,
        // `startedAt` is kept: the stage did start, and the amendment is a
        // continuation of it rather than a fresh run. Wiping it would misreport the
        // elapsed time of work that genuinely happened.
        subtasks: absorbing
          ? s.subtasks.map((sub) => (sub.id === absorbing.id ? amend(sub) : sub))
          : [...s.subtasks, amend(undefined)],
      };
      return;
    }

    later[i] = {
      ...cleared,
      startedAt: undefined,
      subtasks: s.subtasks.map((subtask) => ({
        ...subtask,
        status: "pending" as const,
        startedAt: undefined,
        finishedAt: undefined,
        failureReason: undefined,
        sessionId: undefined,
        reply: undefined,
        activity: undefined,
      })),
    };
  });
  return { later, discarded };
}

/**
 * Undoes what one correction did to the stages after it.
 *
 * The mirror of amendment, and strictly better than re-opening them: the amendment
 * a correction added is removed and each stage is handed back the settlement it had
 * *before* the correction, so a withdrawn finding costs those stages nothing at all.
 * Previously this could only re-open them, because their replies had already been
 * destroyed and there was nothing to restore — which is why `CorrectionUndo` said it
 * covered the corrected stage alone.
 *
 * A stage whose amendment already **ran** has done real work that is now being
 * thrown away, so that work is booked in the ledger. Only that work: everything the
 * stage did before the amendment is exactly what it is being restored to.
 *
 * Falls back to a plain re-open for a stage carrying no amendment from this
 * correction — one added by a route change, or predating amendments — because there
 * is no snapshot to restore and the old rule still holds: it ran against output that
 * has just changed.
 */
function withdrawAmendments(
  pipeline: TaskPipeline,
  index: number,
  from: { stageId: string; correctionAt?: string },
  at: string,
  reason: string,
): { later: TaskStage[]; discarded: DiscardedRun[] } {
  const causedByThis = (subtask: Subtask) =>
    subtask.correction?.upstream?.stageId === from.stageId &&
    (from.correctionAt === undefined || subtask.correction?.at === from.correctionAt);

  const later: TaskStage[] = [];
  const discarded: DiscardedRun[] = [];

  pipeline.stages.forEach((s, i) => {
    if (i <= index) return;
    const amendments = s.subtasks.filter(causedByThis);
    if (amendments.length === 0) {
      const { later: fallback, discarded: booked } = reopenAfter(pipeline, i - 1, at, reason);
      later[i] = fallback[i];
      discarded.push(...booked.filter((entry) => entry.stageId === s.id));
      return;
    }

    // The settlement to restore is the one captured by the *earliest* amendment from
    // this correction — the state before it touched the stage at all.
    const undo = amendments[0].correction?.undo;
    const spent = subtasksUsage(amendments);
    if (hasUsage(spent)) {
      discarded.push({
        stageId: s.id,
        stageName: s.name,
        at,
        reason,
        collateral: true,
        costUsd: spent.costUsd,
        tokens: spent.tokens,
        elapsedMs: spent.elapsedMs,
        sessions: spent.measured + spent.unmeasured,
      });
    }

    later[i] = {
      ...s,
      subtasks: s.subtasks.filter((sub) => !causedByThis(sub)),
      ...(undo
        ? {
            status: undo.status,
            finishedAt: undo.finishedAt,
            verdict: undo.verdict,
            verification: undo.verification,
            blocked: undo.blocked,
          }
        : // No snapshot: hand it back rather than invent a settlement, the same rule
          // `undoCorrection` follows for its own stage.
          { status: "awaiting-approval" as const, finishedAt: undefined, blocked: undefined }),
    };
  });

  return { later, discarded };
}

/**
 * Splices a stage a running stage proposed, at an index the harness derived.
 *
 * Adds work and nothing else: no stage is re-opened, no settlement cleared, no evidence
 * invalidated. That is what makes it the cheapest of the mutations to admit — a wrongly
 * inserted stage costs a session and a click, where a wrongly *removed* one costs the
 * assurance it carried, which is why there is no removal counterpart and never will be.
 *
 * Refuses to land in front of a stage that has already settled. `ruleInsertionIndex`
 * floors at the frontier for exactly this reason, and the check is repeated here rather
 * than trusted, because an index arriving from a caller is not the same fact as an
 * index this module computed.
 */
export function insertStage(
  pipeline: TaskPipeline,
  stage: TaskStage,
  index: number,
): Result<TaskPipeline, PipelineError> {
  if (index < 0 || index > pipeline.stages.length) {
    return err({ kind: "notCorrectable", message: "That is not a position in this route." });
  }
  if (pipeline.stages.some((s) => s.id === stage.id)) {
    return err({ kind: "notCorrectable", message: `Stage "${stage.id}" is already in this route.` });
  }
  const settledAfter = pipeline.stages
    .slice(index)
    .find((s) => s.status === "passed" || s.status === "skipped");
  if (settledAfter) {
    return err({
      kind: "notCorrectable",
      message:
        `"${stage.name}" cannot go in front of "${settledAfter.name}", which has already ` +
        "settled.",
    });
  }

  const stages = [...pipeline.stages.slice(0, index), stage, ...pipeline.stages.slice(index)];
  return ok({ ...pipeline, stages });
}

export function correctStage(
  pipeline: TaskPipeline,
  stageId: string,
  correction: {
    finding: string;
    at: string;
    title?: string;
    /**
     * Set when this repair is a *reverify* — an earlier stage whose output a later one
     * found stale — rather than a correction of the stage's own work.
     *
     * Recorded as an amendment for the reason `Subtask.correction.upstream` exists: a
     * preview that previewed the scripts as they stood was correct when it ran, and a
     * ledger calling that a correction points the next investigation at the stage that
     * did nothing wrong. Named after the stage that *discovered* the staleness, which
     * is what makes it withdrawable alongside that stage's own repair.
     */
    upstream?: { stageId: string; stageName: string };
  },
): Result<TaskPipeline, PipelineError> {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) return err(unknownStage(stageId));

  const stage = pipeline.stages[index];
  if (!isCorrectable(stage)) {
    return err({
      kind: "notCorrectable",
      message:
        `"${stage.name}" has not produced anything to correct. Run it first, or ` +
        "send the findings back to a stage that has.",
    });
  }
  const finding = correction.finding.trim();
  if (!finding) {
    return err({
      kind: "notCorrectable",
      message: "A correction needs to say what is wrong; there is nothing to act on.",
    });
  }

  const corrections = stage.subtasks.filter((s) => s.correction).length;
  const fix: Subtask = {
    id: `${stage.id}-fix-${corrections + 1}`,
    // Numbered, because a stage corrected twice is a signal in its own right: the
    // second attempt at the same finding usually means the finding was misread.
    title:
      correction.title?.trim() ||
      (correction.upstream
        ? `Reverify for ${correction.upstream.stageName}`
        : `Correction ${corrections + 1}`),
    prompt: finding,
    status: "pending",
    // Marks this as a repair rather than part of the stage's original plan, so a
    // reader can tell a stage that took three goes from one split into three units.
    correction: {
      finding,
      at: correction.at,
      ...(correction.upstream
        ? { upstream: { ...correction.upstream, findings: [finding], reverify: true } }
        : {}),
      // What this correction is about to clear off the stage. A finding can be
      // wrong — a comment acted on before it was investigated — and withdrawing
      // one is only cheap if the stage's own conclusion comes back with it.
      undo: {
        status: stage.status,
        finishedAt: stage.finishedAt,
        verdict: stage.verdict,
        verification: stage.verification,
        blocked: stage.blocked,
      },
    },
  };

  const { later, discarded } = reopenAfter(
    pipeline,
    index,
    correction.at,
    correction.upstream
      ? `re-opened by a reverify of ${stage.name}`
      : `re-opened by a correction to ${stage.name}`,
    // Amended rather than rebuilt. They still run — they were built on output that
    // just changed — but they start from what they already worked out.
    { stageId: stage.id, stageName: stage.name, finding },
  );

  const stages = pipeline.stages.map((s, at) => {
    if (at < index) return s;
    if (at > index) return later[at];
    // The corrected stage keeps everything it did. Only its own settlement is undone.
    return {
      ...s,
      status: "pending" as const,
      finishedAt: undefined,
      // Its verdict and verification were about the version being corrected.
      verdict: undefined,
      verification: undefined,
      blocked: undefined,
      subtasks: [...s.subtasks, fix],
    };
  });

  // The stages after this one are being thrown away, so the work they declined goes
  // with them. Without this the items merely go dormant and return the moment those
  // stages pass again, which makes a correction look as though it changed nothing.
  const settled = settleDiscardedDeferrals(
    { ...pipeline, stages },
    pipeline.stages.slice(index + 1).map((s) => s.id),
    correction.at,
  );

  return ok({
    ...settled,
    currentStage: stage.id,
    pendingQuestion: undefined,
    pendingDenials: undefined,
    ...(discarded.length > 0
      ? { discarded: [...(pipeline.discarded ?? []), ...discarded] }
      : {}),
  });
}

/**
 * The correction a stage could withdraw, if any: its most recent one.
 *
 * Exported for the same reason `isCorrectable` is — the tree's context value and
 * the command must not disagree about whether the action is available.
 *
 * Most recent rather than any, because corrections stack: each one snapshotted the
 * settlement *the one before it* had already cleared, so undoing them out of order
 * would restore a conclusion that a correction still standing had invalidated.
 */
export function undoableCorrection(stage: TaskStage): Subtask | undefined {
  for (let i = stage.subtasks.length - 1; i >= 0; i--) {
    const subtask = stage.subtasks[i];
    if (subtask.correction) return subtask.status === "active" ? undefined : subtask;
  }
  return undefined;
}

/**
 * Withdraws the amendments a correction demonstrably could not have reached.
 *
 * Run when a correction subtask *finishes*, which is the earliest moment the question
 * can be asked at all: `correctStage` cascades when the operator files the finding,
 * and what the fix would touch is not knowable until it has touched it. So the
 * cascade still happens exactly as before and this takes back the part of it that the
 * evidence rules out — which also means a route with no measurement behaves, at every
 * step, precisely as it did before this existed.
 *
 * Withdrawing rather than never-amending is what keeps the ledger honest too: these
 * stages were re-opened, and `withdrawAmendments` already knows how to put a stage
 * back where it was, because withdrawing a correction has always had to.
 *
 * Three rules beyond the ones `amendmentIsUnreachable` states:
 *
 * - **Only an amendment that has not run.** One with a reply or an activity record has
 *   already been paid for, and removing it would delete the account of a session that
 *   happened — the opposite of the saving, and a hole in the history.
 * - **Only an amendment carrying this one correction.** An absorbed amendment answers
 *   several corrections of the same upstream stage at once, and this knows the written
 *   paths of the newest alone. Reaching a verdict about the others from it would be
 *   settling a review against a change nobody looked at.
 * - **Nothing is booked as discarded**, for the same reason an amendment is not:
 *   these stages kept everything they had, and no session was spent.
 */
export function narrowAmendments(
  pipeline: TaskPipeline,
  stageId: string,
  correctionSubtaskId: string,
): TaskPipeline {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) return pipeline;

  const fix = pipeline.stages[index].subtasks.find((s) => s.id === correctionSubtaskId);
  if (!fix?.correction || fix.correction.upstream) return pipeline;
  const paths = fix.activity?.pathsWritten;

  const withdrawable = (subtask: Subtask) =>
    subtask.status === "pending" &&
    !subtask.reply &&
    !subtask.activity &&
    subtask.correction?.upstream?.stageId === stageId &&
    subtask.correction.upstream.findings?.length === 1;

  let narrowed = false;
  const stages = pipeline.stages.map((stage, i) => {
    if (i <= index) return stage;
    const amendment = stage.subtasks.find(withdrawable);
    if (!amendment || !amendmentIsUnreachable(stage, paths)) return stage;

    narrowed = true;
    const undo = amendment.correction!.undo;
    return {
      ...stage,
      subtasks: stage.subtasks.filter((sub) => sub.id !== amendment.id),
      ...(undo
        ? {
            status: undo.status,
            finishedAt: undo.finishedAt,
            verdict: undo.verdict,
            verification: undo.verification,
            blocked: undo.blocked,
          }
        : // No snapshot means this stage's settlement was never captured, so there is
          // nothing to restore it to and the amendment is left to run. Inventing one
          // is how a review comes to be recorded as passed by a mechanism whose whole
          // job was to decide it had nothing to do.
          {}),
    };
  });

  return narrowed ? { ...pipeline, stages } : pipeline;
}

/**
 * Withdraws a correction from a stage, restoring the settlement it cleared.
 *
 * The inverse `correctStage` never had. A correction is filed on a finding, and a
 * finding can be wrong — investigated afterwards, or raised by someone reading the
 * report rather than the code. Until this existed, withdrawing one meant editing
 * the state file by hand or re-running the stage from cold, which is the demolition
 * `correctStage` was built to avoid, arrived at from the other direction.
 *
 * What comes back and what does not, stated plainly because a partial undo silently
 * believed to be total is worse than none:
 *
 * - **The corrected stage** is restored exactly — its status, verdict, verification
 *   and `BLOCKED:` reason all come from the snapshot the correction took. Everything
 *   else on it was kept by `correctStage` and never left.
 * - **Later stages do not.** `correctStage` re-opened them and cleared their replies
 *   and activity; those runs are gone, and nothing here can produce them. They stay
 *   pending and must run again. This is the cost of the correction, not of undoing it.
 * - **Deferrals settled** by the correction stay settled. They belonged to runs that
 *   no longer exist either, and anything still true is raised afresh by the re-run.
 *
 * The correction's own cost is moved to `discarded` rather than deleted with it: a
 * withdrawn correction is money that was spent on this route, and the ledger's whole
 * point is that what a route cost is what was spent on it.
 */
export function undoCorrection(
  pipeline: TaskPipeline,
  stageId: string,
  at: string,
): Result<TaskPipeline, PipelineError> {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) return err(unknownStage(stageId));

  const stage = pipeline.stages[index];
  const fix = undoableCorrection(stage);
  if (!fix) {
    return err({
      kind: "notCorrectable",
      message: stage.subtasks.some((s) => s.correction && s.status === "active")
        ? `A correction to "${stage.name}" is running. Stop the task before withdrawing it.`
        : `"${stage.name}" has no correction to withdraw.`,
    });
  }

  const totals = subtasksUsage([fix]);
  const subtasks = stage.subtasks.filter((s) => s.id !== fix.id);
  const undo = fix.correction?.undo;

  const restored: TaskStage = {
    ...stage,
    subtasks,
    // Absent on a correction filed before undo snapshots existed. The subtask still
    // goes, which is the destructive half and the half that matters; the stage is
    // handed back to the operator rather than given a settlement invented here.
    // Guessing a verdict is the one thing this must not do.
    //
    // `awaiting-approval`, emphatically not `pending`: the stage's own subtasks are
    // all `done`, and `nextAction` reads an unresolved stage with nothing left to run
    // as `blocked` — a state its own comment calls impossible, because `finishSubtask`
    // is the only thing that ever produced it. `approveStage` then refuses the stage
    // for not awaiting approval, so the fallback meant to let the operator approve
    // again left the route with no move at all. Awaiting approval is the one status
    // that is both honest — nothing here certified the work — and resolvable.
    ...(undo
      ? {
          status: undo.status,
          finishedAt: undo.finishedAt,
          verdict: undo.verdict,
          verification: undo.verification,
          blocked: undo.blocked,
        }
      : { status: "awaiting-approval" as const, finishedAt: undefined, blocked: undefined }),
  };

  // The same rule filing a correction follows, and for the same reason: the stages
  // after this one ran against output that has just changed. A plan corrected, applied
  // by the stages after it, and then un-corrected leaves those stages holding work
  // built from a plan that no longer exists — so they are re-opened here exactly as
  // `correctStage` re-opens them. Note this may re-open stages that had *already* been
  // re-opened and re-run since the correction was filed, which is the whole point.
  const { later, discarded } = withdrawAmendments(
    pipeline,
    index,
    { stageId: stage.id, correctionAt: fix.correction?.at },
    at,
    `re-opened by withdrawing a correction to ${stage.name}`,
  );
  const stages = pipeline.stages.map((s, i) =>
    i === index ? restored : i > index ? later[i] : s,
  );

  // What those re-opened runs declined goes with them, or the items go dormant and
  // return the moment the stages pass again.
  const settled = settleDiscardedDeferrals(
    { ...pipeline, stages },
    pipeline.stages.slice(index + 1).map((s) => s.id),
    at,
  );

  const withdrawn: DiscardedRun[] = hasUsage(totals)
    ? [
        {
          stageId: stage.id,
          stageName: stage.name,
          at,
          reason: `correction withdrawn: ${fix.correction?.finding ?? fix.title}`,
          costUsd: totals.costUsd,
          tokens: totals.tokens,
          elapsedMs: totals.elapsedMs,
          sessions: totals.measured + totals.unmeasured,
        },
      ]
    : [];
  const ledger = [...withdrawn, ...discarded];

  return ok({
    ...settled,
    // The stage is settled again when the snapshot said it was, so pointing the route
    // at it would park a finished route on a stage with nothing to do — the next
    // unresolved stage is one of the ones just re-opened.
    currentStage:
      restored.status === "pending" || restored.status === "awaiting-approval"
        ? stage.id
        : (stages[index + 1]?.id ?? pipeline.currentStage),
    pendingQuestion: undefined,
    pendingDenials: undefined,
    updatedAt: at,
    ...(ledger.length > 0
      ? { discarded: [...(pipeline.discarded ?? []), ...ledger] }
      : {}),
  } as TaskPipeline);
}

export function planStage(
  pipeline: TaskPipeline,
  stageId: string,
  specs: readonly SubtaskSpec[],
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));
  if (!stage.splittable) {
    return err({
      kind: "notSplittable",
      message: `Stage "${stage.name}" runs as a single unit and cannot be split.`,
    });
  }
  if (stage.subtasks.length > 0) {
    return err({
      kind: "alreadyPlanned",
      message: `Stage "${stage.name}" already has subtasks.`,
    });
  }
  if (specs.length === 0) {
    return err({
      kind: "emptySplit",
      message: `Splitting "${stage.name}" produced no subtasks.`,
    });
  }

  const subtasks: Subtask[] = specs.map((spec, index) => ({
    id: `${stage.id}-${index + 1}`,
    title: spec.title,
    prompt: spec.prompt,
    workflow: spec.workflow,
    status: "pending",
  }));

  return ok(replaceStage(pipeline, { ...stage, subtasks }));
}

/**
 * Records that an agent session has started for a subtask, marking its stage
 * active and making it the pipeline's current stage.
 */
export function startSubtask(
  pipeline: TaskPipeline,
  subtaskId: string,
  options: { sessionId?: string; at: string },
): Result<TaskPipeline, PipelineError> {
  const found = locate(pipeline, subtaskId);
  if (!found) return err(unknownSubtask(subtaskId));
  const { stage, subtask } = found;
  if (subtask.status !== "pending") {
    return err({
      kind: "alreadyResolved",
      message: `Subtask "${subtask.title}" is ${subtask.status}, not pending.`,
    });
  }

  const updated: TaskStage = {
    ...stage,
    status: "active",
    startedAt: stage.startedAt ?? options.at,
    subtasks: stage.subtasks.map((s) =>
      s.id === subtaskId
        ? {
            ...s,
            status: "active",
            sessionId: options.sessionId,
            startedAt: options.at,
          }
        : s,
    ),
  };

  return ok({
    ...replaceStage(pipeline, updated),
    currentStage: stage.id,
  });
}

/**
 * Records the outcome of a subtask and settles its stage if that was the last
 * unresolved one. A failed subtask fails the whole stage — the route is a
 * sequence of preconditions, so silently continuing past a failure would make
 * every later stage untrustworthy.
 */
export function finishSubtask(
  pipeline: TaskPipeline,
  subtaskId: string,
  outcome: {
    status: "done" | "failed" | "skipped";
    at: string;
    reason?: string;
    /** What the agent said, kept so the stage is not invisible afterwards. */
    reply?: string;
    /** What it actually did: tools, commands, files, output. */
    activity?: SubtaskActivity;
  },
): Result<TaskPipeline, PipelineError> {
  const found = locate(pipeline, subtaskId);
  if (!found) return err(unknownSubtask(subtaskId));
  const { stage, subtask } = found;
  if (subtask.status !== "active" && subtask.status !== "pending") {
    return err({
      kind: "alreadyResolved",
      message: `Subtask "${subtask.title}" is already ${subtask.status}.`,
    });
  }

  const subtasks = stage.subtasks.map((s) =>
    s.id === subtaskId
      ? {
          ...s,
          status: outcome.status,
          finishedAt: outcome.at,
          failureReason: outcome.status === "failed" ? outcome.reason : undefined,
          // Kept on failure too — a failed stage is the one you most want to read.
          reply: outcome.reply?.trim() || s.reply,
          activity: outcome.activity ?? s.activity,
        }
      : s,
  );

  return ok(settleStage(pipeline, { ...stage, subtasks }, outcome.at));
}

/** Applies the stage-level consequence of its subtasks' statuses. */
function settleStage(
  pipeline: TaskPipeline,
  stage: TaskStage,
  at: string,
): TaskPipeline {
  const unresolved = stage.subtasks.some(
    (s) => s.status === "pending" || s.status === "active",
  );
  if (unresolved) {
    return { ...replaceStage(pipeline, stage), currentStage: stage.id };
  }

  const failed = stage.subtasks.some((s) => s.status === "failed");
  const status: TaskStage["status"] = failed
    ? "failed"
    : stage.requiresApproval
      ? "awaiting-approval"
      : "passed";

  const settled: TaskStage = { ...stage, status, finishedAt: at };
  const updated = replaceStage(pipeline, settled);

  // Hold currentStage on a stage that still needs attention; clear it once the
  // stage has genuinely passed so a pipeline at rest reports no current stage.
  return {
    ...updated,
    currentStage: status === "passed" ? undefined : stage.id,
  };
}

/**
 * Records the verification items a behaviour review produced. Replaces any
 * previous list for the stage, since a re-run supersedes its own earlier output.
 */
export function recordChecklist(
  pipeline: TaskPipeline,
  stageId: string,
  /**
   * Plain strings, or items carrying the gate they belong to.
   *
   * Both accepted so every existing caller and test keeps working unchanged — a route
   * that declares no scopes produces no scoped items, and a bare string is the same
   * item it always was.
   */
  items: readonly (string | { text: string; scope?: string })[],
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));

  const checklist: ChecklistItem[] = items.map((entry, index) => {
    const { text, scope } = typeof entry === "string" ? { text: entry, scope: undefined } : entry;
    return {
      id: `${stage.id}-c${index + 1}`,
      text,
      checked: false,
      raisedByStage: stage.id,
      ...(scope ? { scope } : {}),
    };
  });

  return ok(replaceStage(pipeline, { ...stage, checklist }));
}

/** Ticks or un-ticks a verification item, optionally recording what was seen. */
export function setChecklistItem(
  pipeline: TaskPipeline,
  itemId: string,
  update: { checked: boolean; note?: string; at: string },
): Result<TaskPipeline, PipelineError> {
  for (const stage of pipeline.stages) {
    if (!stage.checklist?.some((i) => i.id === itemId)) continue;
    const checklist = stage.checklist.map((item) =>
      item.id === itemId
        ? {
            ...item,
            checked: update.checked,
            note: update.note ?? item.note,
            checkedAt: update.checked ? update.at : undefined,
          }
        : item,
    );
    return ok(replaceStage(pipeline, { ...stage, checklist }));
  }
  return err({
    kind: "unknownChecklistItem",
    message: `No checklist item "${itemId}" in pipeline.`,
  });
}

/**
 * Records steps only the operator can take, against the stage that named them.
 *
 * Kept as checklist items rather than a parallel list, because the mechanism wanted
 * already exists: an outstanding item refuses to let a stage's gate pass. What is new
 * is only that these gate *any* stage, not just a human-verification one.
 *
 * Deduplicated on the text per stage, like deferrals: a split stage's subtasks each run
 * cold, and two of them printing the same pull-request link is one step, not two.
 */
/**
 * Records why a stage did not do its work, alongside holding it.
 *
 * Separate from the hold so the reason survives independently: a hold that cannot take
 * effect (the stage had not settled) must not silently discard the explanation, which
 * is the only account of what was missing.
 */
export function recordStageBlocked(
  pipeline: TaskPipeline,
  stageId: string,
  reason: string,
): TaskPipeline {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage || !reason.trim()) return pipeline;
  return replaceStage(pipeline, { ...stage, blocked: reason.trim() });
}

export function recordActions(
  pipeline: TaskPipeline,
  stageId: string,
  texts: readonly string[],
): TaskPipeline {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage || texts.length === 0) return pipeline;

  const existing = stage.checklist ?? [];
  const seen = new Set(existing.map((i) => i.text));
  const added = texts
    .filter((text) => !seen.has(text) && text.trim().length > 0)
    .map((text, at) => ({
      id: `${stageId}-a${existing.length + at + 1}`,
      text,
      kind: "action" as const,
      checked: false,
      raisedByStage: stageId,
    }));
  if (added.length === 0) return pipeline;

  return replaceStage(pipeline, { ...stage, checklist: [...existing, ...added] });
}

/**
 * Checks every outstanding checklist item at once.
 *
 * The convenience is real — a supervisor running several tasks ticks the same eight
 * boxes per task — but so is the cost: the human-verification gate's entire value is
 * that somebody confirmed each behaviour, and a bulk tick is the obvious way to make
 * that gate ceremonial.
 *
 * So the note is mandatory at the caller, and recorded against every item this
 * touches. An item ticked in bulk and one ticked after actually exercising the
 * behaviour would otherwise be indistinguishable in the report, and the report is
 * the only lasting evidence that the gate meant anything. An existing note is kept
 * and the bulk note appended, because a note written before the tick is the more
 * specific of the two.
 *
 * Already-checked items are left completely alone, including their notes: a bulk
 * tick must not overwrite the record of an individual verification.
 */
export function checkOutstandingChecklist(
  pipeline: TaskPipeline,
  options: {
    stageId?: string;
    /**
     * Tick only what this verification gate is responsible for.
     *
     * Without it, a bulk tick at a `local` gate would also tick the items that belong
     * to the deployed-site gate — a statement that somebody exercised a behaviour in an
     * environment the change had not reached. The gate's own value is that each item
     * was confirmed *somewhere it could be seen*, and ticking across scopes is the
     * quiet way to lose that.
     */
    forGate?: string;
    note: string;
    at: string;
  },
): { pipeline: TaskPipeline; checked: number } {
  let checked = 0;
  const allowed = options.forGate
    ? new Set(itemsForGate(pipeline, options.forGate).map((item) => item.id))
    : undefined;

  const stages = pipeline.stages.map((stage) => {
    // Skipped stages are excluded for the same reason `outstandingChecklist` excludes
    // them: their items gate nothing, so ticking them would inflate the count with
    // work that is not owed.
    if (stage.status === "skipped") return stage;
    if (options.stageId && stage.id !== options.stageId) return stage;
    if (!stage.checklist?.some((item) => !item.checked)) return stage;

    const checklist = stage.checklist.map((item) => {
      if (item.checked) return item;
      // Belongs to a different verification gate, so it is not this operator's to tick.
      if (allowed && !allowed.has(item.id)) return item;
      // An operator action is excluded from a bulk tick. Ticking a verification in
      // bulk is a judgement about risk; ticking "I opened the pull request" in bulk is
      // simply untrue, and the step it stands for is the one this exists to protect.
      if (item.kind === "action") return item;
      checked += 1;
      return {
        ...item,
        checked: true,
        checkedAt: options.at,
        note: item.note ? `${item.note} — ${options.note}` : options.note,
      };
    });
    return { ...stage, checklist };
  });

  if (checked === 0) return { pipeline, checked: 0 };
  return { pipeline: { ...pipeline, stages }, checked };
}

/**
 * Registers the numbered steps of the plan a stage is about to execute.
 *
 * Idempotent, and deliberately preserving: a step already accounted for keeps its
 * account when the steps are re-read, so a stage re-run after a refused tool call
 * does not lose what its earlier attempt reported. Only the title is refreshed,
 * since the plan file may have been edited between runs.
 *
 * A step the plan no longer contains is dropped. The plan document is the authority
 * on what the steps are — that is the whole reason identity comes from the file —
 * so holding a stage on a step its plan no longer has would be unaccountable.
 */
export function recordPlanSteps(
  pipeline: TaskPipeline,
  stageId: string,
  steps: readonly PlanStep[],
): TaskPipeline {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return pipeline;

  const existing = new Map((stage.planSteps ?? []).map((record) => [record.number, record]));
  const planSteps: PlanStepRecord[] = steps.map((step) => {
    const previous = existing.get(step.number);
    return previous
      ? { ...previous, title: step.title }
      : { number: step.number, title: step.title, status: "unaccounted" as const };
  });

  return replaceStage(pipeline, {
    ...stage,
    planSteps: planSteps.length > 0 ? planSteps : undefined,
  });
}

/**
 * Records what a stage said about each step of its plan.
 *
 * An account for a number the plan does not have is ignored rather than added. The
 * steps come from the document; a reply that invents a step 9 is describing its own
 * reading, and adding it would let a stage account for work nobody asked about while
 * a real step stayed unmentioned.
 */
export function recordStepAccounts(
  pipeline: TaskPipeline,
  stageId: string,
  accounts: readonly StepAccount[],
  at: string,
): TaskPipeline {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage?.planSteps || accounts.length === 0) return pipeline;

  const byNumber = new Map(accounts.map((account) => [account.number, account]));
  const planSteps = stage.planSteps.map((record) => {
    const account = byNumber.get(record.number);
    if (!account) return record;
    return {
      ...record,
      status: account.state,
      note: account.note?.trim() || record.note,
      at,
    };
  });

  return replaceStage(pipeline, { ...stage, planSteps });
}

/**
 * Steps of a stage's plan that the stage said nothing about.
 *
 * The one query the whole mechanism turns on. A stage with any of these has not
 * accounted for the plan it was given, and cannot be passed — see `approveStage`.
 */
export function unaccountedPlanSteps(
  pipeline: TaskPipeline,
  stageId: string,
): PlanStepRecord[] {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage || stage.status === "skipped") return [];
  return (stage.planSteps ?? []).filter((record) => record.status === "unaccounted");
}

/**
 * Steps a stage reported it did not do, across the whole pipeline.
 *
 * Reported rather than held here: the runner turns each into a deferral, so the
 * existing hold in front of a stage that ships, and the settlement that requires a
 * sentence, apply to a step nobody executed exactly as they do to work a stage
 * declined. The two are the same fact arriving by different routes.
 */
export function unexecutedPlanSteps(
  pipeline: TaskPipeline,
): { stage: TaskStage; step: PlanStepRecord }[] {
  return pipeline.stages
    .filter((stage) => stage.status !== "skipped")
    .flatMap((stage) =>
      (stage.planSteps ?? [])
        .filter((step) => step.status === "not-done")
        .map((step) => ({ stage, step })),
    );
}

/**
 * Records work a stage declined as belonging to a different stage.
 *
 * Deduplicated on the text, per stage: a split stage's subtasks each run cold and
 * each notice the same missing structure, and three identical items would read as
 * three separate problems.
 */
export function recordDeferrals(
  pipeline: TaskPipeline,
  stageId: string,
  texts: readonly string[],
  at: string,
): TaskPipeline {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return pipeline;

  const existing = pipeline.deferrals ?? [];
  // Across every stage, not just this one. The item is the *work*; it does not become
  // different work because a different stage noticed it. One task carried the same
  // "the preview is stale" observation eleven times, raised by four stages and by
  // three re-runs of two of them, and the one item nobody owned was lost among them.
  const seen = new Set(existing.map((d) => deferralKey(d.text)));

  const added: DeferralItem[] = [];
  for (const raw of texts) {
    const text = raw.trim().slice(0, MAX_DEFERRAL_CHARS);
    const key = deferralKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    // An item whose own text names the stage that owns it is not a deferral. It is
    // recorded, because the observation is real and belongs in the report, but settled
    // on sight: holding the route to ask a human who owns work whose owner is quoted in
    // the item is pure noise, and it is the noise that made a real task accumulate 40
    // declined items, 27 of them the same four observations reworded.
    const owner = ownedByPendingStage(text, pipeline, stageId);
    added.push({
      id: `d${existing.length + added.length + 1}`,
      text,
      raisedByStage: stageId,
      raisedByStageName: stage.name,
      at,
      ...(owner
        ? {
            resolved: true,
            resolution: ownedByStageResolution(owner),
            resolvedAt: at,
          }
        : {}),
    });
  }
  if (added.length === 0) return pipeline;
  return { ...pipeline, deferrals: [...existing, ...added] };
}

/**
 * A deferral's identity, for telling the same observation from a second one.
 *
 * Exact text failed because each stage rewords what it saw, and a re-run reworded it
 * again: "`ec-preview.md` is stale relative to the current artifact (Addendum 6 step
 * 61)" and "…(Addendum 7 step 66)" are one fact, filed twice.
 *
 * So the volatile parts go: backticks and quoting, parenthetical asides, digits, and
 * anything after an em-dash — which is where a stage puts its guess at who owns the
 * work, and two stages guessing differently about one item is not two items.
 *
 * Deliberately not fuzzy matching. This normalises away the things that demonstrably
 * varied; it does not try to judge whether two different sentences mean the same
 * thing, because merging two real items is worse than listing one twice.
 */
function deferralKey(text: string): string {
  return text
    .toLowerCase()
    // The owner guess, and the justification after it.
    .split(/\s[—–]\s|\s--\s/)[0]
    .replace(/\([^)]*\)/g, " ")
    .replace(/[`'"*_]/g, "")
    .replace(/\d+/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Settles the declines belonging to runs that are being discarded.
 *
 * The half of the re-open rule that was only ever asserted. Re-opening a stage clears
 * its checklist and its plan steps for a stated reason — they were raised by a run that
 * no longer exists — and the same sentence claimed deferrals were "ignored, exactly as
 * that stage's checklist items are discarded". They were not. They stayed on the
 * pipeline, and `outstandingDeferrals` only *hid* them while the raising stage was
 * pending. The moment it passed again, they came back.
 *
 * Which made a correction look like it had achieved nothing: a real task corrected a
 * stage, watched the four stages after it re-run and pass, and found the same fourteen
 * items waiting — every one raised by a run that had since been thrown away.
 *
 * Settled rather than deleted, which is what `DeferralItem` says about itself: the
 * record of what was noticed, and what became of it, survives in the report. Anything
 * still true is raised again by the re-run, which is what makes discarding safe.
 */
export function settleDiscardedDeferrals(
  pipeline: TaskPipeline,
  stageIds: readonly string[],
  at: string,
): TaskPipeline {
  const discarded = new Set(stageIds);
  if (!pipeline.deferrals?.length || discarded.size === 0) return pipeline;

  let changed = false;
  const deferrals = pipeline.deferrals.map((item) => {
    if (item.resolved || !discarded.has(item.raisedByStage)) return item;
    changed = true;
    return {
      ...item,
      resolved: true,
      resolution:
        "Raised by a run that was discarded when the stage was re-opened. The stage " +
        "ran again; anything still outstanding was raised afresh.",
      resolvedAt: at,
    };
  });
  return changed ? { ...pipeline, deferrals } : pipeline;
}

/**
 * Deferrals nobody has settled, ignoring any raised by a stage that has since
 * been re-opened or skipped.
 *
 * The exclusion matters as much as the list. Reverting to an earlier stage
 * discards what the later ones produced, and a deferral raised by work that no
 * longer exists would hold a deployment on an observation about a run that has
 * been thrown away — the same reasoning that discards those stages' checklist
 * items.
 */
export function outstandingDeferrals(pipeline: TaskPipeline): DeferralItem[] {
  const settled = new Set(
    pipeline.stages
      .filter((s) => s.status === "passed" || s.status === "skipped")
      .map((s) => s.id),
  );
  return (pipeline.deferrals ?? []).filter(
    (item) => !item.resolved && settled.has(item.raisedByStage),
  );
}

/**
 * Settles one deferral: the work has an owner now, or it needed nobody.
 *
 * The reason is kept rather than the item deleted. "We decided this structure is
 * live-only and the publish stage creates it" is exactly the knowledge that was
 * missing when every stage declined the work in the first place, and a route that
 * forgets it will lose it again on the next task.
 */
export function resolveDeferral(
  pipeline: TaskPipeline,
  itemId: string,
  update: { resolution: string; at: string },
): Result<TaskPipeline, PipelineError> {
  const items = pipeline.deferrals ?? [];
  if (!items.some((item) => item.id === itemId)) {
    return err({
      kind: "unknownDeferral",
      message: `No deferred item "${itemId}" in pipeline.`,
    });
  }
  return ok({
    ...pipeline,
    ...counted(
      pipeline,
      { kind: "deferral", stageId: items.find((i) => i.id === itemId)?.raisedByStage },
      update.at,
    ),
    deferrals: items.map((item) =>
      item.id === itemId
        ? {
            ...item,
            resolved: true,
            resolution: update.resolution.trim() || undefined,
            resolvedAt: update.at,
          }
        : item,
    ),
  });
}

/**
 * Every unchecked verification item across the pipeline. This is what the
 * human-verification gate is measured against — items raised by any stage
 * accumulate into one list, so a behaviour review early in the route still
 * blocks sign-off at the end.
 */
export function outstandingChecklist(pipeline: TaskPipeline): ChecklistItem[] {
  return pipeline.stages
    .filter((s) => s.status !== "skipped")
    .flatMap((s) => s.checklist ?? [])
    .filter((item) => !item.checked);
}

/**
 * Returns an in-flight subtask to pending, discarding its session.
 *
 * Used when a stage asks for information rather than doing the work: nothing was
 * attempted, so recording it as done would be a lie and recording it as failed
 * would block the route. It goes back in the queue to be re-run once the brief
 * has been answered.
 */
/**
 * Records a stage's question so it outlives the session that asked it.
 *
 * Only one is held at a time: the runner stops at the first question, so a
 * second could only arrive after this one is answered.
 */
export function recordQuestion(
  pipeline: TaskPipeline,
  asked: {
    stageId: string;
    stageName: string;
    subtaskId: string;
    questions: string[];
    /**
     * The background the stage offered, shown once beside the questions.
     *
     * Carried because the tool asks for it: the questions are kept to one line each
     * by telling the model its findings belong here instead, which is only true if
     * this survives. Dropped, that instruction would silently discard the reasoning.
     */
    context?: string;
    at: string;
    /**
     * Set when the agent is blocked on this question, waiting on ask_user.
     * Answering it hands the answer back to that live session instead of
     * enriching the brief and re-running the subtask.
     */
    liveCallId?: string;
  },
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === asked.stageId);
  if (!stage) {
    return err({ kind: "unknownStage", message: `No stage "${asked.stageId}".` });
  }
  const items = asked.questions
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text, index) => ({ id: `${asked.subtaskId}-q${index + 1}`, text }));
  if (items.length === 0) {
    return err({
      kind: "unknownQuestion",
      message: "A stage asked for information without saying what.",
    });
  }

  return ok({
    ...pipeline,
    pendingQuestion: {
      stageId: asked.stageId,
      stageName: asked.stageName,
      subtaskId: asked.subtaskId,
      askedAt: asked.at,
      items,
      context: asked.context?.trim() || undefined,
      liveCallId: asked.liveCallId,
    },
  });
}

/** Records one answer, leaving the others outstanding. */
export function answerQuestion(
  pipeline: TaskPipeline,
  itemId: string,
  answer: string,
  /** When the human answered. Optional so the count is opt-in per caller. */
  at?: string,
): Result<TaskPipeline, PipelineError> {
  const pending = pipeline.pendingQuestion;
  if (!pending) {
    return err({
      kind: "noPendingQuestion",
      message: "Nothing is waiting on an answer.",
    });
  }
  if (!pending.items.some((item) => item.id === itemId)) {
    return err({ kind: "unknownQuestion", message: `No question "${itemId}".` });
  }
  const trimmed = answer.trim();
  return ok({
    ...pipeline,
    ...counted(pipeline, { kind: "answer", stageId: pending.stageId }, at),
    pendingQuestion: {
      ...pending,
      items: pending.items.map((item) =>
        item.id === itemId ? { ...item, answer: trimmed || undefined } : item,
      ),
    },
  });
}

/** Questions still without an answer. */
export function unansweredQuestions(pipeline: TaskPipeline): QuestionItem[] {
  return (pipeline.pendingQuestion?.items ?? []).filter(
    (item) => !item.answer?.trim(),
  );
}

/**
 * Records the tool calls a stage was refused, so they outlive the notification.
 *
 * The rule is stored alongside each refusal rather than re-derived later: it is
 * computed from the command that was actually attempted, which is gone once the
 * session ends.
 */
export function recordDenials(
  pipeline: TaskPipeline,
  refused: {
    stageId: string;
    stageName: string;
    subtaskId: string;
    items: readonly Omit<DenialItem, "id" | "granted">[];
    at: string;
  },
): Result<TaskPipeline, PipelineError> {
  if (!pipeline.stages.some((s) => s.id === refused.stageId)) {
    return err(unknownStage(refused.stageId));
  }
  const items: DenialItem[] = refused.items.map((item, index) => ({
    ...item,
    id: `${refused.subtaskId}-d${index + 1}`,
  }));
  if (items.length === 0) {
    return err({
      kind: "unknownQuestion",
      message: "No refusals to record.",
    });
  }

  return ok({
    ...pipeline,
    pendingDenials: {
      stageId: refused.stageId,
      stageName: refused.stageName,
      subtaskId: refused.subtaskId,
      refusedAt: refused.at,
      items,
    },
  });
}

/** Marks one refusal's rule as written, leaving the rest outstanding. */
export function grantDenial(
  pipeline: TaskPipeline,
  itemId: string,
  /** When the rule was written. Optional so the count is opt-in per caller. */
  at?: string,
): Result<TaskPipeline, PipelineError> {
  const pending = pipeline.pendingDenials;
  if (!pending) {
    return err({
      kind: "noPendingQuestion",
      message: "Nothing was refused.",
    });
  }
  if (!pending.items.some((item) => item.id === itemId)) {
    return err({ kind: "unknownQuestion", message: `No refusal "${itemId}".` });
  }
  return ok({
    ...pipeline,
    ...counted(pipeline, { kind: "permission", stageId: pending.stageId }, at),
    pendingDenials: {
      ...pending,
      items: pending.items.map((item) =>
        item.id === itemId ? { ...item, granted: true } : item,
      ),
    },
  });
}

/** Refusals whose rule has not been written yet. */
export function ungrantedDenials(pipeline: TaskPipeline): DenialItem[] {
  return (pipeline.pendingDenials?.items ?? []).filter((item) => !item.granted);
}

/** Clears the recorded refusals, once granted or deliberately ignored. */
export function clearDenials(pipeline: TaskPipeline): TaskPipeline {
  if (!pipeline.pendingDenials) return pipeline;
  const { pendingDenials: _dealtWith, ...rest } = pipeline;
  return rest;
}

/** Clears the outstanding questions, once they are answered or abandoned. */
export function clearQuestion(pipeline: TaskPipeline): TaskPipeline {
  if (!pipeline.pendingQuestion) return pipeline;
  const { pendingQuestion: _answered, ...rest } = pipeline;
  return rest;
}

export function revertSubtask(
  pipeline: TaskPipeline,
  subtaskId: string,
  /** When the revert was ordered. Optional so the count is opt-in per caller. */
  at?: string,
): Result<TaskPipeline, PipelineError> {
  const found = locate(pipeline, subtaskId);
  if (!found) return err(unknownSubtask(subtaskId));
  const { stage, subtask } = found;
  if (subtask.status !== "active" && subtask.status !== "pending") {
    return err({
      kind: "alreadyResolved",
      message: `Subtask "${subtask.title}" is ${subtask.status} and cannot be reverted.`,
    });
  }

  const subtasks = stage.subtasks.map((s) =>
    s.id === subtaskId
      ? {
          ...s,
          status: "pending" as const,
          sessionId: undefined,
          startedAt: undefined,
          finishedAt: undefined,
          failureReason: undefined,
        }
      : s,
  );

  // If nothing else in the stage has started, the stage is back to pending too.
  const anyProgress = subtasks.some((s) => s.status !== "pending");
  return ok({
    ...replaceStage(pipeline, {
      ...stage,
      status: anyProgress ? stage.status : "pending",
      subtasks,
    }),
    ...counted(pipeline, { kind: "revert", stageId: stage.id }, at),
    currentStage: anyProgress ? pipeline.currentStage : undefined,
  });
}

/**
 * Records what an assessment stage concluded about each stage of the route.
 *
 * Stored, not applied. Applying happens at the gate, because the whole reason an
 * assessment exists rather than a checkbox is that a human reads the evidence before
 * stages stop running — and a mapping applied on arrival would have skipped them
 * before anyone looked.
 *
 * Conclusions about the assessing stage itself, or about stages that have already
 * resolved, are dropped: the first is meaningless and the second would rewrite
 * history from a reading of a diff.
 */
export function recordAssessments(
  pipeline: TaskPipeline,
  stageId: string,
  assessments: readonly StageAssessment[],
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));

  const known = new Map(pipeline.stages.map((s) => [s.id, s]));
  const kept = assessments.filter((entry) => {
    if (entry.stageId === stageId) return false;
    const target = known.get(entry.stageId);
    return target !== undefined && target.status === "pending";
  });

  return ok(replaceStage(pipeline, { ...stage, assessments: [...kept] }));
}

/**
 * Stages an approved assessment says are already done.
 *
 * Exposed so a caller can say what approving will do before it does it.
 */
export function assessedAsDone(
  pipeline: TaskPipeline,
  stageId: string,
): StageAssessment[] {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  return (stage?.assessments ?? []).filter((entry) => entry.done);
}

/**
 * Approves a stage held at a human gate, allowing the route to advance.
 *
 * The human-verification gate additionally requires the accumulated checklist
 * to be clear: it is the point where the process demands evidence rather than
 * an assertion that the work is done.
 *
 * Only that gate enforces the checklist. Behaviour reviews raise items and pass
 * straight through — if each enforced its own items, none could ever reach the
 * end, and the accumulated list would be unreachable code.
 */
export function approveStage(
  pipeline: TaskPipeline,
  stageId: string,
  at: string,
  /**
   * Something the operator wants later stages to know, given at the moment they
   * have just read what this stage produced. Recorded rather than acted on here:
   * the engine runs nothing.
   */
  note?: string,
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));
  if (stage.status !== "awaiting-approval") {
    return err({
      kind: "notAwaitingApproval",
      message: `Stage "${stage.name}" is ${stage.status}, not awaiting approval.`,
    });
  }

  // Verification items gate the human-verification stage, which is the one place a
  // route asks "has someone confirmed this behaves". Operator *actions* gate the stage
  // that raised them, whatever its kind: a pull request nobody opened makes the next
  // stage wrong, and the point of recording the step was that it must not be skipped.
  // Scoped to the gate, so a route can verify the same change in more than one
  // environment. `itemsForGate` collapses to "every unchecked item" when no gate in the
  // pipeline declares a scope, which is what this line did before — so a route that has
  // not opted in behaves identically and needs no migration.
  const outstanding =
    stage.kind === "humanVerification"
      ? itemsForGate(pipeline, stage.id)
      : (stage.checklist ?? []).filter((i) => !i.checked && i.kind === "action");
  if (outstanding.length > 0) {
    const actionsOnly = outstanding.every((i) => i.kind === "action");
    return err({
      kind: "checklistIncomplete",
      message:
        `"${stage.name}" has ${outstanding.length} outstanding ` +
        `${actionsOnly ? "step(s) for you to do" : "verification item(s)"}: ` +
        outstanding.map((i) => i.text).join("; "),
      outstanding: outstanding.length,
    });
  }

  // A stage that executed a written plan must have said something about every
  // numbered step. Enforced here rather than only in the runner because approval is
  // the other way a stage passes, and the failure this closes is precisely a stage
  // passing with a step nobody had accounted for. Note what it does *not* require: a
  // step reported as not done passes fine — it becomes a deferral, which holds the
  // next stage that ships. What cannot pass is silence.
  const unaccounted = unaccountedPlanSteps(pipeline, stageId);
  if (unaccounted.length > 0) {
    return err({
      kind: "planStepsUnaccounted",
      message:
        `"${stage.name}" has not accounted for ${unaccounted.length} step(s) of ` +
        `${stage.planFile ?? "its plan"}: ` +
        unaccounted.map((step) => `${step.number}. ${step.title}`).join("; ") +
        ". Re-run the stage, or record what happened to each.",
      steps: unaccounted.map((step) => step.number),
    });
  }

  const trimmed = note?.trim();
  const guidance = trimmed
    ? [
        ...(pipeline.guidance ?? []),
        {
          id: `g${(pipeline.guidance?.length ?? 0) + 1}`,
          stageId: stage.id,
          stageName: stage.name,
          text: trimmed,
          at,
        },
      ]
    : pipeline.guidance;

  // An approved assessment is where its conclusions take effect. Marked *skipped*
  // with the evidence attached, never passed: a stage that ran has a report and
  // possibly a verify exit code, while this has an agent's reading of a diff, and
  // recording them alike would make the pipeline stop being a record of what
  // happened. Only pending stages are touched, so nothing that already ran is
  // rewritten.
  const assessed = stage.kind === "assessment" ? assessedAsDone(pipeline, stage.id) : [];
  const byId = new Map(assessed.map((entry) => [entry.stageId, entry]));
  const withAssessment = pipeline.stages.map((candidate) => {
    const entry = byId.get(candidate.id);
    if (!entry || candidate.status !== "pending") return candidate;
    return {
      ...candidate,
      status: "skipped" as const,
      skipReason: `assessed as already done: ${entry.evidence}`,
      finishedAt: at,
      subtasks: candidate.subtasks.map((subtask) =>
        subtask.status === "pending"
          ? { ...subtask, status: "skipped" as const, finishedAt: at }
          : subtask,
      ),
    };
  });

  return ok({
    ...replaceStage(
      { ...pipeline, stages: withAssessment },
      { ...stage, status: "passed", finishedAt: at },
    ),
    ...counted(pipeline, { kind: "approval", stageId: stage.id }, at),
    currentStage: undefined,
    guidance,
  });
}

/**
 * Skips a stage outright, along with any subtasks not already resolved. Used to
 * step past a stage a route prescribes but this particular task does not need.
 */
export function skipStage(
  pipeline: TaskPipeline,
  stageId: string,
  at: string,
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));
  if (stage.status === "passed" || stage.status === "skipped") {
    return err({
      kind: "alreadyResolved",
      message: `Stage "${stage.name}" is already ${stage.status}.`,
    });
  }

  const subtasks = stage.subtasks.map((s) =>
    s.status === "pending" || s.status === "active"
      ? { ...s, status: "skipped" as const, finishedAt: at }
      : s,
  );

  return ok({
    ...replaceStage(pipeline, {
      ...stage,
      status: "skipped",
      subtasks,
      finishedAt: at,
    }),
    ...counted(pipeline, { kind: "skip", stageId: stage.id }, at),
    currentStage: undefined,
  });
}

/**
 * Resets a failed or resolved stage back to pending so it can be attempted
 * again. A splittable stage is emptied, sending it back through `planStage` —
 * a stage that failed usually failed because the split was wrong.
 */
export function retryStage(
  pipeline: TaskPipeline,
  stageId: string,
  /** When the retry was ordered. Optional so the count is opt-in per caller. */
  at?: string,
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));

  // A splittable stage is emptied so it goes back through `planStage` — except when
  // it carries a correction. The retained rounds are the whole saving `correctStage`
  // exists for, and a stage that failed *after* being corrected did not fail because
  // its split was wrong: it failed for the reason on the row, which is usually the
  // transport. Emptying it would throw away exactly the work this command was added
  // to stop people throwing away.
  const corrected = stage.subtasks.some((s) => s.correction);
  // And only the units that did not finish are re-opened. A stage fails as soon as any
  // subtask does, so its siblings are routinely `done` — re-running those would be the
  // waste this command exists to avoid, at its most expensive on the corrected stage
  // above, where the finished units are the rounds being preserved. Their replies were
  // kept either way; what changes is that they are not paid for again.
  const subtasks = stage.splittable && !corrected
    ? []
    : stage.subtasks.map((s) =>
        s.status === "done" || s.status === "skipped"
          ? s
          : {
              ...s,
              status: "pending" as const,
              sessionId: undefined,
              startedAt: undefined,
              finishedAt: undefined,
              failureReason: undefined,
            },
      );

  return ok({
    ...replaceStage(pipeline, {
      ...stage,
      status: "pending",
      subtasks,
      startedAt: undefined,
      finishedAt: undefined,
    }),
    ...counted(pipeline, { kind: "retry", stageId: stage.id }, at),
    currentStage: undefined,
  });
}

export interface PipelineProgress {
  /** Stages resolved as passed or skipped. */
  stagesComplete: number;
  stagesTotal: number;
  /** Subtasks resolved in any terminal state. */
  subtasksComplete: number;
  subtasksTotal: number;
  /** Verification items still to be checked by a human. */
  checklistOutstanding: number;
  currentStageName?: string;
}

/**
 * Derived summary for display. Kept in the domain rather than the UI so the
 * counting rules have one definition and are covered by these tests.
 */
export function pipelineProgress(pipeline: TaskPipeline): PipelineProgress {
  const resolvedStage = (s: TaskStage) =>
    s.status === "passed" || s.status === "skipped";
  const resolvedSubtask = (s: Subtask) => s.status !== "pending" && s.status !== "active";

  const allSubtasks = pipeline.stages.flatMap((s) => s.subtasks);
  const current = pipeline.stages.find((s) => s.id === pipeline.currentStage);

  return {
    stagesComplete: pipeline.stages.filter(resolvedStage).length,
    stagesTotal: pipeline.stages.length,
    subtasksComplete: allSubtasks.filter(resolvedSubtask).length,
    subtasksTotal: allSubtasks.length,
    checklistOutstanding: outstandingChecklist(pipeline).length,
    currentStageName: current?.name,
  };
}

function locate(
  pipeline: TaskPipeline,
  subtaskId: string,
): { stage: TaskStage; subtask: Subtask } | undefined {
  for (const stage of pipeline.stages) {
    const subtask = stage.subtasks.find((s) => s.id === subtaskId);
    if (subtask) return { stage, subtask };
  }
  return undefined;
}

function replaceStage(pipeline: TaskPipeline, stage: TaskStage): TaskPipeline {
  return {
    ...pipeline,
    stages: pipeline.stages.map((s) => (s.id === stage.id ? stage : s)),
  };
}

function unknownStage(stageId: string): PipelineError {
  return { kind: "unknownStage", message: `No stage "${stageId}" in pipeline.` };
}

function unknownSubtask(subtaskId: string): PipelineError {
  return {
    kind: "unknownSubtask",
    message: `No subtask "${subtaskId}" in pipeline.`,
  };
}
