import { ReviewRule } from "./reviewRules";
import { RouteDefinition } from "./taskRoute";
import { TaskPipeline, TaskStage } from "./taskPipeline";

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
const REFRESHABLE = ["intent", "model"] as const;

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

function findDefinition(
  source: StageDefinitionSource,
  routeId: string,
  stage: Pick<TaskStage, "id" | "addedByRule">,
): { intent?: string; model?: string } | undefined {
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
