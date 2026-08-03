import { Result, ok, err } from "../utilities/result";
import {
  ChecklistItem,
  Subtask,
  TaskPipeline,
  TaskStage,
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
  | { kind: "unknownChecklistItem"; message: string };

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

  const gateIndex = pipeline.stages.findIndex(
    (s) => s.kind === "humanVerification",
  );
  const stages = [...pipeline.stages];
  stages.splice(gateIndex === -1 ? stages.length : gateIndex, 0, ...added);

  return { pipeline: { ...pipeline, stages }, added, matches };
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
  outcome: { status: "done" | "failed" | "skipped"; at: string; reason?: string },
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

  return ok({
    ...replaceStage(pipeline, { ...stage, status: "passed", finishedAt: at }),
    currentStage: undefined,
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
