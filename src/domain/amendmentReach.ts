/**
 * Whether a correction could have reached the stage it re-opened.
 *
 * `upstreamAmendment` made a downstream stage cheap to re-run by giving it its own
 * previous output instead of a cold start. What it did not do is ask whether the
 * stage needed to run at all — every stage after the corrected one is re-opened
 * unconditionally, which was right when the alternative was leaving a stage recorded
 * as passed against output that moved.
 *
 * Measured on `Build the Dealer Review Summary pyramid`, 25 Aug 2026: **32 amendments
 * ran and 29 of them wrote no file — $7.66 of $9.12.** The clearest single episode is
 * a correction that added one line, `@using DevExpress.Web.Mvc.UI`, to a Razor view.
 * It wrote exactly one path and re-opened twelve stages, among them the SQL migration
 * review, the SQL object review and the resx culture review — each of which spent a
 * session reading the finding, going to look, and reporting back in as many words:
 * *"The finding is a Razor compile error"*, *"**Changed: nothing.**"*. Thirteen
 * sessions and $2.92 to establish something the rule that added those stages had
 * already stated.
 *
 * Because that is what a rule-added review *is*: a stage that exists because some
 * changed path matched a pattern. `ruleInsertionIndex` keys those stages off git's
 * changed paths in the first place, so asking the same question of a correction's
 * written paths is the same question, one cascade later. If nothing the correction
 * wrote matches the pattern that put the stage there, the stage's subject is
 * untouched and its previous conclusion still stands.
 *
 * **Rule-added stages only, and that is the whole boundary.** A route stage's subject
 * is whatever its intent says, which no pattern describes — a build stage is about
 * every file, a deployment about what it ships, and guessing from paths what an
 * arbitrary stage cares about is exactly the inference this codebase refuses
 * everywhere else. A rule stage is the one kind that declared its own subject.
 *
 * Four rules, each load-bearing:
 *
 * - **Unmeasured means reachable.** A correction with no activity record, a stage
 *   recorded before `rulePaths` existed, an unparsable pattern: every one of them
 *   amends exactly as it did before. The failure direction is chosen — a stage
 *   amended for nothing costs a session, and a stage wrongly left settled is a review
 *   standing on output it never saw, which is the failure the cascade exists to
 *   prevent.
 * - **A correction that wrote nothing reaches everything.** Zero written paths is
 *   the shape of both "it changed nothing" and "nothing was recorded", and those are
 *   not the same fact. `stageProductivity` already refuses to read absence as zero.
 * - **Never a stage that is running, failed or held.** This narrows a *pending*
 *   amendment nobody has spent anything on yet. A stage doing something has a reason
 *   to be doing it that no path list can see.
 * - **Matched on the same normalisation as the rules themselves** — forward slashes,
 *   case-insensitive — because these paths come from `SubtaskActivity.pathsWritten`,
 *   which on Windows are absolute and backslashed, and a rule pattern is written
 *   against a repository-relative path. A pattern that fails to match for a spelling
 *   reason would silently switch a review off, which is the one outcome worth more
 *   than the saving.
 */

import { TaskStage } from "./taskPipeline";

/** A path as a rule would see it: forward slashes, lower case. */
function normalise(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Whether any written path matches the rule that added this stage.
 *
 * `undefined` — not `true` or `false` — when the question cannot be answered: no
 * declared pattern, no measured paths, or a pattern that will not compile. Callers
 * treat that as reachable; it is returned distinctly so nothing has to infer a
 * measurement from a boolean that also means "no".
 */
export function correctionReaches(
  stage: Pick<TaskStage, "addedByRule" | "rulePaths">,
  pathsWritten: readonly string[] | undefined,
): boolean | undefined {
  if (!stage.addedByRule || !stage.rulePaths) return undefined;
  if (!pathsWritten || pathsWritten.length === 0) return undefined;

  let pattern: RegExp;
  let except: RegExp | undefined;
  try {
    pattern = new RegExp(stage.rulePaths.pathPattern, "i");
    except = stage.rulePaths.exceptPattern
      ? new RegExp(stage.rulePaths.exceptPattern, "i")
      : undefined;
  } catch {
    // A pattern the rules loader accepted and this cannot compile is a disagreement
    // between two readers of one string. Answering "no" would settle a review on it.
    return undefined;
  }

  return pathsWritten
    .map(normalise)
    .some((path) => pattern.test(path) && !except?.test(path));
}

/**
 * Whether this stage's pending amendment can be withdrawn because the correction
 * that caused it could not have reached the stage.
 *
 * Deliberately keyed on the stage being *pending* rather than on the amendment
 * subtask alone: `reopenAfter` sets the stage pending as it appends the amendment, so
 * anything else means something has happened since, and a stage that is running,
 * failed or blocked is not one to quietly settle behind its own back.
 */
export function amendmentIsUnreachable(
  stage: Pick<TaskStage, "addedByRule" | "rulePaths" | "status">,
  pathsWritten: readonly string[] | undefined,
): boolean {
  if (stage.status !== "pending") return false;
  return correctionReaches(stage, pathsWritten) === false;
}
