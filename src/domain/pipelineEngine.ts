import { Result, ok, err } from "../utilities/result";
import {
  ChecklistItem,
  DenialItem,
  QuestionItem,
  Subtask,
  SubtaskActivity,
  TaskPipeline,
  TaskStage,
  truncateHandoff,
} from "./taskPipeline";
import { RouteDefinition, RouteStageDefinition } from "./taskRoute";
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
  | { kind: "emptySplit"; message: string }
  | { kind: "alreadyPlanned"; message: string }
  | { kind: "alreadyResolved"; message: string }
  | { kind: "notAwaitingApproval"; message: string }
  | { kind: "checklistIncomplete"; message: string; outstanding: number }
  | { kind: "unknownChecklistItem"; message: string }
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
  /** No stages left. */
  | { kind: "done" };

/** Instantiates a route into fresh pipeline state. */
export function createPipeline(route: RouteDefinition): TaskPipeline {
  return {
    routeId: route.id,
    routeLabel: route.label,
    stages: route.stages.map((definition) => createStage(definition)),
  };
}

function createStage(
  definition: RouteStageDefinition,
  addedByRule?: string,
): TaskStage {
  return {
    id: definition.id,
    name: definition.label,
    kind: definition.kind,
    status: "pending",
    intent: definition.intent,
    addedByRule,
    model: definition.model,
    splittable: definition.splittable,
    requiresApproval: definition.gate === "approval",
    ...(definition.sendBackTo && definition.sendBackTo.length > 0
      ? { sendBackTo: [...definition.sendBackTo] }
      : {}),
    ...(definition.handoff ? { handoff: true } : {}),
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
    added.push(createStage(definition, match.rule.reason));
  }

  if (added.length === 0) return { pipeline, added, matches };

  const stages = [...pipeline.stages];
  stages.splice(ruleInsertionIndex(pipeline.stages), 0, ...added);

  return { pipeline: { ...pipeline, stages }, added, matches };
}

/**
 * Where a rule's reviews belong: before anything irreversible happens.
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
export function ruleInsertionIndex(stages: readonly TaskStage[]): number {
  const barrier = stages.findIndex(
    (stage) =>
      (stage.status === "pending" || stage.status === "awaiting-approval") &&
      (stage.kind === "deployment" || stage.kind === "humanVerification"),
  );
  return barrier === -1 ? stages.length : barrier;
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
  items: readonly string[],
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));

  const checklist: ChecklistItem[] = items.map((text, index) => ({
    id: `${stage.id}-c${index + 1}`,
    text,
    checked: false,
    raisedByStage: stage.id,
  }));

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
      liveCallId: asked.liveCallId,
    },
  });
}

/** Records one answer, leaving the others outstanding. */
export function answerQuestion(
  pipeline: TaskPipeline,
  itemId: string,
  answer: string,
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
    currentStage: anyProgress ? pipeline.currentStage : undefined,
  });
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

  const outstanding =
    stage.kind === "humanVerification" ? outstandingChecklist(pipeline) : [];
  if (outstanding.length > 0) {
    return err({
      kind: "checklistIncomplete",
      message:
        `"${stage.name}" has ${outstanding.length} unchecked verification ` +
        `item(s): ${outstanding.map((i) => i.text).join("; ")}`,
      outstanding: outstanding.length,
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

  return ok({
    ...replaceStage(pipeline, { ...stage, status: "passed", finishedAt: at }),
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
): Result<TaskPipeline, PipelineError> {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return err(unknownStage(stageId));

  const subtasks = stage.splittable
    ? []
    : stage.subtasks.map((s) => ({
        ...s,
        status: "pending" as const,
        sessionId: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        failureReason: undefined,
      }));

  return ok({
    ...replaceStage(pipeline, {
      ...stage,
      status: "pending",
      subtasks,
      startedAt: undefined,
      finishedAt: undefined,
    }),
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
