import { isCorrectable } from "./pipelineEngine";
import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * Where a stage's failed check sends the work, and whether that is available now.
 *
 * The gap this closes: a failed `verify` had exactly one disposition, and it was a
 * person — with the two commands offered on the row both wrong for it. `retryStage`
 * re-opens the failed subtask cold and clears its `failureReason`, so the re-run reaches
 * the same exit code for the same reasons; `revertToStage` discards the stage and
 * everything after it. The primitive built for exactly this case, `correctStage`, was
 * reachable only by the operator reading the check's output, working out which stage
 * owed the fix, and typing the finding in by hand.
 *
 * What this module does is *route* a failure. It never interprets one. The finding handed
 * to the repair is the check's own output, verbatim, because reading severity out of an
 * exit code is a thing the harness must not learn to do: `Test-WorkPromoted.ps1` exits 2
 * with three sections of which two say nothing is wrong, and any rule confident enough to
 * pick the third would also have fired on RU-550, where the check failed only because the
 * pull request it asked for was still open. A route can declare a check; saying what its
 * failure *means* belongs to whatever reads it.
 *
 * Phase one deliberately stops at offering the repair. What the operator does with the
 * offer — accepts the declared owner, retargets, or rejects it — is the measurement that
 * licenses doing it automatically, and it is a measurement this codebase has had to take
 * before: `sendBackTargets` agreed with the operator 11 times in 19, which is why nothing
 * derives a repair target on its own.
 */

/** Why a declared repair cannot be offered. Ordered by how the operator should read it. */
export type RepairUnavailable =
  /** The stage has not failed a check, so there is nothing to route. */
  | "no-failure"
  /** The route declares no owner for this check's failure. */
  | "not-declared"
  /** The declared owner is not a stage of this pipeline — a route edited since. */
  | "unknown-stage"
  /**
   * The owner has produced nothing to correct.
   *
   * `correctStage` works by handing a session the stage's own previous output and saying
   * what is wrong with it, so a stage with no reply and no activity gives it nothing to
   * start from — `sendBackTargets` learned the same thing from the other end, where a
   * stage that had written zero files across twelve subtasks was being recommended.
   */
  | "nothing-to-correct";

export interface DeclaredRepair {
  /** The stage that owes the fix. */
  owner: TaskStage;
  /** The stage whose check failed. */
  failed: TaskStage;
  /**
   * The check's verbatim account of itself, for use as the correction's finding.
   *
   * Read from the failed subtask's own recorded reason rather than re-run: the command
   * has already executed, and executing it again to obtain the text would be a second
   * answer to a question already answered — possibly a different one.
   */
  finding: string;
}

/**
 * The repair a failed check declares, or why there is none.
 *
 * Keyed on a failed **subtask carrying a reason**, not on the stage's status. A stage
 * fails as soon as any subtask does while its siblings stay pending, so `stage.status`
 * is routinely `active` on a stage that has stopped — the same shape `stagePresentation`
 * had to be corrected for, where a row said "In progress" on a route that had failed and
 * the one command that could move it was not offered.
 */
export function declaredRepair(
  pipeline: TaskPipeline,
  stageId: string,
): DeclaredRepair | RepairUnavailable {
  const failed = pipeline.stages.find((stage) => stage.id === stageId);
  if (!failed) return "no-failure";

  const reason = failed.subtasks
    .filter((subtask) => subtask.status === "failed")
    .map((subtask) => subtask.failureReason?.trim())
    .find((text): text is string => !!text);
  if (!reason) return "no-failure";

  const target = failed.onFailure?.repair;
  if (!target) return "not-declared";

  const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
  const ownerIndex = pipeline.stages.findIndex((stage) => stage.id === target);
  // Re-checked here rather than trusted from config. The declaration was validated
  // against the *route* at load, and a pipeline is a snapshot of a route that may since
  // have been reordered by `repositionRouteStages` — so ordering is a property of this
  // pipeline, and reading it from anywhere else would be reading the wrong artefact.
  if (ownerIndex === -1 || ownerIndex >= index) return "unknown-stage";

  const owner = pipeline.stages[ownerIndex];
  if (!isCorrectable(owner)) return "nothing-to-correct";

  return { owner, failed, finding: reason };
}

/** Whether `declaredRepair` found one, for callers that only want the happy path. */
export function isDeclaredRepair(
  result: DeclaredRepair | RepairUnavailable,
): result is DeclaredRepair {
  return typeof result !== "string";
}

/**
 * The finding a declared repair carries, headed so the session knows where it came from.
 *
 * The attribution is the load-bearing part, and `formatSendBackNote` learned it first: by
 * the time the repair runs, the failure is a line on a stage the session is not reading,
 * so without a header the check's output arrives from nowhere. It also says the check is
 * *the* reason, which stops a correction treating the output as a general invitation to
 * improve the stage — the narrowing `correctionPrompt` depends on.
 */
export function formatCheckFailureNote(repair: DeclaredRepair): string {
  return (
    `The check on "${repair.failed.name}" failed, and this stage owns the fix. ` +
    `Read its output and correct only what the output shows is wrong; where a section ` +
    `of it reports nothing wrong, there is nothing there to do.\n\n${repair.finding}`
  );
}
