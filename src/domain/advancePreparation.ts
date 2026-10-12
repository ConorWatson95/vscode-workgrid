import { ruleInsertionIndex } from "./pipelineEngine";
import {
  StageDefinitionSource,
  addMissingStages,
  refreshPendingStages,
  repositionRouteStages,
  repositionRuleStages,
  syncHandoffs,
} from "./stageRefresh";
import { TaskPipeline } from "./taskPipeline";

/**
 * What changes when a route is about to advance, and why each change was made.
 *
 * Every runner does this before asking the engine what is next — the extension's
 * Advance Route and a headless runner alike — because a pipeline is a snapshot and
 * `harness.json` may have changed since it was taken. It lived inside the VS Code
 * command, which made it unreachable from anything else: a headless runner skipping it
 * would run a route the operator had already corrected, with nothing to say so.
 */
export interface AdvancePreparation {
  pipeline: TaskPipeline;
  /** False when nothing differs, so the caller can skip a save. */
  changed: boolean;
  /** What was done, for the log. */
  notes: string[];
  /**
   * What could not be done and needs the operator. Shown, not only logged: a route that
   * gained a step in front of a gate already running refuses it, and an advance that
   * declines a stage in silence looks exactly like one where config never changed.
   */
  warnings: string[];
}

/**
 * Brings a pipeline in line with config before an advance, in the order the steps
 * depend on: stages the route gained (before the intent refresh, so a new stage gets
 * the current wording), stages the route reordered (before rule stages, whose
 * position is computed relative to route stages), intents and models of stages that
 * have not run, handoff flags, and finally rule stages. Each step leaves anything that
 * has already run where it ran — see `stageRefresh.ts` for each one's reasons.
 *
 * `definitions` is absent where no config could be read; rule stages are still
 * repositioned then, since that needs only the pipeline itself.
 */
export function prepareAdvance(
  pipeline: TaskPipeline,
  definitions: StageDefinitionSource | undefined,
  at: string,
): AdvancePreparation {
  let current = pipeline;
  const notes: string[] = [];
  const warnings: string[] = [];

  if (definitions) {
    const grown = addMissingStages(current, definitions);
    if (grown.added.length > 0) {
      current = grown.pipeline;
      notes.push(`added ${grown.added.join(", ")} from harness.json.`);
    }
    if (grown.tooLate.length > 0) {
      const remedy = grown.blockedBy
        ? `Re-run This Stage… on "${grown.blockedBy}" first, or do those steps by hand.`
        : "Re-run an earlier stage first, or do those steps by hand.";
      warnings.push(
        `cannot run ${grown.tooLate.join(", ")} — the route has moved past where they belong. ${remedy}`,
      );
    }

    const reordered = repositionRouteStages(current, definitions);
    if (reordered.moved.length > 0) {
      current = reordered.pipeline;
      notes.push(
        `moved ${reordered.moved.join(", ")} into the order harness.json now declares. ` +
          "Stages that have already run were left where they ran.",
      );
    }

    const refreshed = refreshPendingStages(current, definitions);
    if (refreshed.changed.length > 0) {
      current = refreshed.pipeline;
      notes.push(`reloaded ${refreshed.changed.join(", ")} from harness.json.`);
    }

    const synced = syncHandoffs(current, definitions, at);
    if (synced.enabled.length > 0 || synced.backfilled.length > 0) {
      current = synced.pipeline;
      const parts = [
        synced.enabled.length > 0 ? `enabled on ${synced.enabled.join(", ")}` : "",
        synced.backfilled.length > 0
          ? `carried forward what ${synced.backfilled.join(", ")} already concluded`
          : "",
      ].filter(Boolean);
      notes.push(`handoffs: ${parts.join("; ")}.`);
    }
  }

  const ordered = repositionRuleStages(current, ruleInsertionIndex);
  if (ordered.moved.length > 0) {
    current = ordered.pipeline;
    notes.push(
      `moved ${ordered.moved.join(", ")} ahead of the first deployment or gate, ` +
        "so they run before anything is shipped.",
    );
  }

  return { pipeline: current, changed: current !== pipeline, notes, warnings };
}
