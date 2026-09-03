import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * Where a stage sits relative to the point the route is actually stopped at.
 *
 * Added because the tree drew every stage's status independently and said nowhere
 * which one the route was on, so a pipeline that had run forward and then had an
 * early stage corrected presented several competing claims about position at once:
 * a held implementation stage, a gate still open five rows below it, and two green
 * ticks after that. Every one of those was true, and read together they said the
 * route was in three places.
 *
 * The history that reconciles them is invisible — the route ran to the last review,
 * a correction re-opened an early stage, and `withdrawAmendments` then restored the
 * later stages to the settlements they had already earned rather than re-running
 * them for a change that never happened. That restoration is deliberate and worth
 * keeping; what was missing is any mark saying which row the route is waiting on.
 */
export type StagePosition =
  /** Resolved, and before the point the route is stopped at. */
  | "behind"
  /** The stage the route is waiting on — what `nextAction` will pick up. */
  | "at"
  /** After that point, whatever its own status says. */
  | "ahead";

/**
 * The stage the route is stopped at: the first that has not resolved.
 *
 * Deliberately derived rather than read from `TaskPipeline.currentStage`, which
 * cannot answer this — `approveStage` sets it to `undefined` on every approval, so
 * on a pipeline whose frontier is a *held* stage behind an approved one it is empty
 * exactly when the question is being asked. This is the same walk `nextAction`
 * makes, and a test pins the two together: a marker that disagreed with the driver
 * would be worse than none.
 */
export function routeFrontier(pipeline: TaskPipeline): TaskStage | undefined {
  return pipeline.stages.find(
    (stage) => stage.status !== "passed" && stage.status !== "skipped",
  );
}

export function positionOf(pipeline: TaskPipeline, stageId: string): StagePosition {
  const frontier = routeFrontier(pipeline);
  // Every stage resolved, so nothing is waiting and nothing is ahead of anything.
  if (!frontier) return "behind";
  if (frontier.id === stageId) return "at";
  const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
  const frontierIndex = pipeline.stages.findIndex((stage) => stage.id === frontier.id);
  // An unknown stage is reported as behind rather than ahead: `ahead` is what draws
  // attention to a gate the route has already passed by, and inventing one for a
  // stage this pipeline does not contain would be a stop with nothing behind it.
  if (index === -1) return "behind";
  return index < frontierIndex ? "behind" : "ahead";
}

/**
 * Whether a stage is an open demand the route has already moved past.
 *
 * The leftover this exists to name: a gate that was awaiting approval before an
 * earlier stage was corrected is still awaiting approval afterwards, and sitting
 * among the rows it looks like the thing to act on next. It is a real outstanding
 * gate and must not be hidden — but it is not where the route is, and the two read
 * identically until one of them says so.
 */
export function isStrandedGate(pipeline: TaskPipeline, stage: TaskStage): boolean {
  if (stage.status !== "awaiting-approval" && stage.status !== "failed") return false;
  return positionOf(pipeline, stage.id) === "ahead";
}
