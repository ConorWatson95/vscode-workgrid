import { ReviewRule } from "./reviewRules";
import { RouteDefinition, sendBackEntryKind, StageKind } from "./taskRoute";
import { TaskPipeline, TaskStage, truncateHandoff } from "./taskPipeline";
import { stageFromDefinition } from "./pipelineEngine";

/**
 * Reloads stage definitions from current project config, and re-opens a stage
 * that has already run so it can be done again properly.
 *
 * Both exist because a pipeline is a **snapshot**. Picking a route fixes the
 * stages the work travels through, which is right — a route edited mid-flight must
 * not rewrite a task already moving through it. But it also froze every stage's
 * `intent`, so fixing a wrong instruction meant recreating the task and losing its
 * history. The observed case: a deployment stage whose intent omitted a scoping
 * flag, so the stage deployed every project instead of one.
 *
 * The rule that makes this safe: **a stage that has already run keeps what it ran
 * with.** History has to stay truthful, so refreshing only touches stages that
 * have not started, and reverting is an explicit act that clears the run it is
 * discarding.
 *
 * Pure and vscode-free.
 */

export interface StageDefinitionSource {
  routes: readonly RouteDefinition[];
  rules: readonly ReviewRule[];
}

/**
 * The parts of a stage that may be reloaded.
 *
 * Deliberately only wording and execution knobs. `splittable` is excluded: it
 * decides how many subtasks a stage has, so changing it would reshape a pipeline
 * rather than correct an instruction — and a non-splittable stage already carries a
 * synthesized subtask that would then be wrong. Structure stays snapshotted; only
 * what the agent is told, and which model tells it, is refreshed.
 *
 * `workflow` is absent because it is a *subtask* field, not a stage one.
 */
const REFRESHABLE = ["intent", "model", "verify", "planFile"] as const;

/**
 * Adds stages a route gained after this pipeline was created.
 *
 * The gap this closes: a route is instantiated once, at task creation, so correcting a
 * route that was missing a step left every task already in flight without it — and the
 * only remedies were to do the step by hand or throw the task away. The argument for
 * doing this is the one that already justifies `refreshPendingStages`: correcting a
 * route should not require a new task.
 *
 * Two rules keep it safe, and both matter:
 *
 * - **Only ahead of the frontier.** A stage is inserted only at a position after every
 *   stage that has started, passed, failed, been skipped or is awaiting approval.
 *   Inserting behind one would mean a route claims to have run a step it never ran,
 *   which is the failure this whole area exists to prevent. A stage whose route
 *   position falls behind the frontier is reported as `tooLate` rather than dropped
 *   silently or forced in.
 * - **Nothing is ever removed.** A stage the route no longer defines stays, because it
 *   may already have run and the pipeline is the record of what happened.
 *
 * Positioned by route order relative to the stages already present, so a stage lands
 * where the route says rather than at the end.
 */
export function addMissingStages(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
): { pipeline: TaskPipeline; added: string[]; tooLate: string[] } {
  const route = source.routes.find((r) => r.id === pipeline.routeId);
  if (!route) return { pipeline, added: [], tooLate: [] };

  const present = new Set(pipeline.stages.map((s) => s.id));
  const missing = route.stages.filter((definition) => !present.has(definition.id));
  if (missing.length === 0) return { pipeline, added: [], tooLate: [] };

  // Everything at or before this index has a history to protect.
  const lastSettled = pipeline.stages.reduce(
    (last, stage, at) => (stage.status === "pending" ? last : at),
    -1,
  );
  const frontier = lastSettled + 1;

  const stages = [...pipeline.stages];
  const added: string[] = [];
  const tooLate: string[] = [];

  for (const definition of missing) {
    // Where the route puts it: after the nearest earlier route stage that the pipeline
    // already has. Recomputed each time, so two new adjacent stages keep their order.
    const routeIndex = route.stages.findIndex((s) => s.id === definition.id);
    let at = 0;
    for (let before = routeIndex - 1; before >= 0; before--) {
      const found = stages.findIndex((s) => s.id === route.stages[before].id);
      if (found !== -1) {
        at = found + 1;
        break;
      }
    }
    if (at < frontier) {
      tooLate.push(definition.id);
      continue;
    }
    stages.splice(at, 0, stageFromDefinition(definition));
    added.push(definition.id);
  }

  if (added.length === 0) return { pipeline, added: [], tooLate };
  return { pipeline: { ...pipeline, stages }, added, tooLate };
}

/**
 * Brings every not-yet-started stage into line with current config.
 *
 * Matched by id. A stage whose id is no longer in config keeps what it has rather
 * than being emptied — it is still going to run, and the pipeline is the source of
 * truth for that.
 *
 * Returns the pipeline unchanged when nothing differs, so callers can skip a save.
 */
export function refreshPendingStages(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
): { pipeline: TaskPipeline; changed: string[] } {
  const changed: string[] = [];

  const stages = pipeline.stages.map((stage) => {
    // Only stages that have not begun. A passed, failed or running stage must keep
    // the instruction it was actually given.
    if (stage.status !== "pending" || stage.subtasks.some((s) => s.status !== "pending")) {
      return stage;
    }
    const definition = findDefinition(source, pipeline.routeId, stage);
    if (!definition) return stage;

    const updates: Partial<TaskStage> = {};
    for (const field of REFRESHABLE) {
      const next = normalize(definition[field]);
      if (normalize(stage[field]) !== next) {
        (updates as Record<string, unknown>)[field] = next;
      }
    }
    if (Object.keys(updates).length === 0) return stage;

    changed.push(stage.id);
    const refreshed = { ...stage, ...updates };
    // A stage's prompt is derived from its intent, so a stale prompt would undo
    // the refresh for the very stage it was meant to fix.
    return {
      ...refreshed,
      subtasks: refreshed.subtasks.map((subtask) =>
        subtask.prompt === stage.intent
          ? { ...subtask, prompt: refreshed.intent }
          : subtask,
      ),
    };
  });

  return changed.length > 0 ? { pipeline: { ...pipeline, stages }, changed } : { pipeline, changed };
}

/**
 * Re-opens a stage and everything after it, discarding those runs.
 *
 * For the case where a stage has already run and got it wrong: the fix is in
 * config, and the stage needs doing again. Later stages go too, because they were
 * built on the output being discarded — leaving them passed would mean approving
 * work that no longer exists.
 *
 * Earlier stages are untouched, and so is the guidance the operator has given:
 * that is the thing most likely to be the reason for reverting.
 */
export function revertToStage(
  pipeline: TaskPipeline,
  stageId: string,
): { pipeline: TaskPipeline; reopened: string[] } | undefined {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) return undefined;

  const reopened: string[] = [];
  const stages = pipeline.stages.map((stage, at) => {
    if (at < index) return stage;
    reopened.push(stage.id);
    return {
      ...stage,
      status: "pending" as const,
      startedAt: undefined,
      finishedAt: undefined,
      // Checklist items were raised by a run that is being discarded, so keeping
      // them would gate the task on evidence about work that no longer exists.
      checklist: undefined,
      // Same reasoning: a step marked done by the run being discarded would let the
      // re-run inherit credit for work that no longer exists, which is the exact
      // confusion per-step accounting exists to remove.
      planSteps: undefined,
      subtasks: stage.subtasks.map((subtask) => ({
        ...subtask,
        status: "pending" as const,
        startedAt: undefined,
        finishedAt: undefined,
        failureReason: undefined,
        sessionId: undefined,
        // What the discarded run said and did is dropped with it; a report showing
        // output from a run that was thrown away is worse than showing none.
        reply: undefined,
        activity: undefined,
      })),
    };
  });

  return {
    pipeline: {
      ...pipeline,
      stages,
      currentStage: undefined,
      // A question or refusal belonged to the run being discarded.
      pendingQuestion: undefined,
      pendingDenials: undefined,
    },
    reopened,
  };
}

/**
 * Moves rule-added reviews that have not run yet back in front of the barrier.
 *
 * A repair, for tasks whose reviews were spliced by an earlier build that placed
 * them before the first human gate — which in a route that deploys to dev before
 * signing off meant *after* the deployment. A pipeline is a snapshot, so fixing
 * the splice rule fixed new tasks and left existing ones with a SQL review
 * scheduled after the SQL had been deployed.
 *
 * Only **pending** rule stages move. A review that has already run stays where it
 * ran: re-ordering history to match the current rule would misreport what actually
 * happened, which is worse than an out-of-date order.
 */
export function repositionRuleStages(
  pipeline: TaskPipeline,
  insertionIndex: (stages: readonly TaskStage[]) => number,
): { pipeline: TaskPipeline; moved: string[] } {
  const barrier = insertionIndex(pipeline.stages);
  const movable = pipeline.stages.filter(
    (stage, index) =>
      index > barrier && stage.addedByRule !== undefined && stage.status === "pending",
  );
  if (movable.length === 0) return { pipeline, moved: [] };

  const rest = pipeline.stages.filter((stage) => !movable.includes(stage));
  // Recomputed against the remaining stages: removing the movable ones can shift
  // where the barrier sits, so splicing at the old index could land past it.
  const target = insertionIndex(rest);
  const stages = [...rest];
  stages.splice(target, 0, ...movable);

  return {
    pipeline: { ...pipeline, stages },
    moved: movable.map((stage) => stage.id),
  };
}

/**
 * Stages a given stage's findings may be sent back to, nearest first.
 *
 * Only what the stage declares in `sendBackTo`, so an undeclared stage offers
 * nothing. Restrictive by default and deliberately so: a planning stage that
 * could send work back to planning would plan forever, and the route is the only
 * thing that knows which loops are the useful ones.
 */
export function sendBackTargets(
  pipeline: TaskPipeline,
  fromStageId: string,
): TaskStage[] {
  const index = pipeline.stages.findIndex((s) => s.id === fromStageId);
  if (index <= 0) return [];

  const allowed = pipeline.stages[index].sendBackTo ?? [];
  if (allowed.length === 0) return [];

  const kinds = allowed
    .map((entry) => sendBackEntryKind(entry))
    .filter((kind): kind is StageKind => kind !== undefined);

  // Reversed: the stage that produced the work under review is the likely target,
  // and it is the one immediately before, not the start of the route. Only earlier
  // stages are ever considered, which is what keeps a kind entry as safe as an id.
  return pipeline.stages
    .slice(0, index)
    .filter((stage) => allowed.includes(stage.id) || kinds.includes(stage.kind))
    .reverse();
}

/**
 * Sends work back to an earlier stage, carrying the findings that justify it.
 *
 * The gap this fills: a review stage reports a critical problem and several
 * lesser ones, and the only way back to implementation was `revertToStage` —
 * which discards the reviewing stage's reply along with everything after the
 * target. So the act of sending work back destroyed the reason for sending it,
 * and the findings had to be copied out by hand first or retyped from memory.
 *
 * Guidance is the carrier. It survives a revert, and every subsequent stage
 * prompt is given all of it, so the re-opened stage reads the findings as
 * instructions without the review's own output needing to be preserved.
 */
export function sendBackToStage(
  pipeline: TaskPipeline,
  input: {
    targetStageId: string;
    /** The stage whose findings these are; must be later than the target. */
    fromStageId: string;
    /** The findings themselves, usually the reviewing stage's reply. */
    findings: string;
    /** Anything the operator wants to add to them. */
    note?: string;
    at: string;
  },
): { pipeline: TaskPipeline; reopened: string[]; note: string } | undefined {
  const targetIndex = pipeline.stages.findIndex((s) => s.id === input.targetStageId);
  const fromIndex = pipeline.stages.findIndex((s) => s.id === input.fromStageId);
  if (targetIndex === -1 || fromIndex === -1) return undefined;
  // Strictly backwards. Sending a stage's findings to itself would discard them
  // as it re-ran, and "back" to a later stage is not a thing this can mean.
  if (targetIndex >= fromIndex) return undefined;
  // Checked here as well as when offering the choice: this is the transition that
  // reshapes the pipeline, and a target the route never sanctioned must not become
  // reachable through a stale menu, a headless caller or a hand-edited state file.
  if (!sendBackTargets(pipeline, input.fromStageId).some((s) => s.id === input.targetStageId)) {
    return undefined;
  }

  const from = pipeline.stages[fromIndex];
  const target = pipeline.stages[targetIndex];
  const text = formatSendBackNote(from.name, input.findings, input.note);

  const reverted = revertToStage(pipeline, input.targetStageId);
  if (!reverted) return undefined;

  return {
    pipeline: {
      ...reverted.pipeline,
      // Attached to the target, not to the stage that raised it: the reviewing
      // stage is about to be re-opened and re-run, and a note filed under it would
      // read as guidance for the review rather than for the work being redone.
      guidance: [
        ...(reverted.pipeline.guidance ?? []),
        {
          // Derived from the stages and the timestamp rather than random, so the
          // transition stays pure and a replay produces the same pipeline.
          id: `sendback-${from.id}-${target.id}-${input.at}`,
          stageId: target.id,
          stageName: target.name,
          text,
          at: input.at,
        },
      ],
    },
    reopened: reverted.reopened,
    note: text,
  };
}

/**
 * The guidance note a send-back leaves behind.
 *
 * Names the stage that raised the findings, because by the time the re-opened
 * stage reads this that stage's own output has been discarded — without the
 * attribution the findings would arrive from nowhere.
 */
export function formatSendBackNote(
  fromStageName: string,
  findings: string,
  note?: string,
): string {
  const parts = [
    `Sent back from "${fromStageName}". Address these findings, and say what you changed for each:`,
    findings.trim(),
  ];
  if (note?.trim()) parts.push(`Also, from the operator: ${note.trim()}`);
  return parts.join("\n\n");
}

function findDefinition(
  source: StageDefinitionSource,
  routeId: string,
  stage: Pick<TaskStage, "id" | "addedByRule">,
):
  | { intent?: string; model?: string; handoff?: boolean; verify?: string; planFile?: string }
  | undefined {
  if (stage.addedByRule) {
    return source.rules.find((rule) => rule.stage.id === stage.id)?.stage;
  }
  const route = source.routes.find((r) => r.id === routeId);
  return route?.stages.find((s) => s.id === stage.id);
}

/** Blank and absent mean the same thing in config, so compare them that way. */
function normalize(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Brings a pipeline's handoff flags in line with config, and backfills the
 * conclusions of stages that have already run.
 *
 * Needed because `handoff` is snapshotted onto a stage at creation, like every
 * other stage field — so a task created before the field existed would never
 * carry anything forward, and the answer would be "recreate your task", which
 * throws away everything already approved.
 *
 * Two halves, and the second is the one that matters. Setting the flag is safe on
 * a stage of any status: unlike `intent`, it is not a record of what the stage ran
 * with, it is a switch deciding whether its conclusion travels. And a stage that
 * has already passed still has its reply persisted, so its conclusion can be
 * recorded now rather than lost for want of a flag that did not exist when it ran.
 *
 * `splittable` is still excluded from all of this, for the reason it always was:
 * it decides how many subtasks a stage has, so changing it reshapes a pipeline
 * mid-flight.
 */
export function syncHandoffs(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
  at: string,
): { pipeline: TaskPipeline; enabled: string[]; backfilled: string[] } {
  const enabled: string[] = [];
  const backfilled: string[] = [];
  // Tracked separately from `enabled`, because turning a flag *off* is also a
  // change: keying the early return on `enabled` alone silently discarded it and
  // the pipeline came back with the flag still set.
  const disabled: string[] = [];

  const stages = pipeline.stages.map((stage) => {
    const definition = findDefinition(source, pipeline.routeId, stage);
    if (!definition) return stage;
    const desired = definition.handoff === true;
    if (desired === (stage.handoff === true)) return stage;
    if (desired) {
      enabled.push(stage.id);
      return { ...stage, handoff: true };
    }
    disabled.push(stage.id);
    return { ...stage, handoff: undefined };
  });

  const handoffs = [...(pipeline.handoffs ?? [])];
  for (const stage of stages) {
    if (!stage.handoff || stage.status !== "passed") continue;
    if (handoffs.some((handoff) => handoff.stageId === stage.id)) continue;
    // The last subtask's reply is the stage's conclusion: a split stage's earlier
    // subtasks are steps towards it, and the final one is where it lands.
    const reply = [...stage.subtasks].reverse().find((subtask) => subtask.reply?.trim())?.reply;
    if (!reply) continue;
    handoffs.push({
      stageId: stage.id,
      stageName: stage.name,
      text: truncateHandoff(reply),
      at,
    });
    backfilled.push(stage.id);
  }

  if (enabled.length === 0 && backfilled.length === 0 && disabled.length === 0) {
    return { pipeline, enabled, backfilled };
  }
  return {
    pipeline: {
      ...pipeline,
      stages,
      ...(handoffs.length > 0 ? { handoffs } : {}),
    },
    enabled,
    backfilled,
  };
}
