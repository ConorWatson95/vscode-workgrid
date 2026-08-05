import { RuleMatch } from "./reviewRules";
import { TaskStage } from "./taskPipeline";

/**
 * Whether appending these reviews is worth asking about first.
 *
 * Rule-added stages are the only ones nobody chose. You pick a route; the engine
 * then appends agent sessions to it based on a derived path set, and each one is
 * minutes of model time and real money. That is fine for one obvious review and
 * not fine for five — a task that had touched one stored procedure was appended an
 * ETL review, a resource-string culture review, a tenant-config review and a
 * tooling test run, all of which ran before anyone saw them.
 *
 * Pure, so the threshold and the wording are testable, and so the decision does not
 * live in the notification that presents it.
 */

/**
 * Above this many new stages in one go, ask.
 *
 * One or two is the ordinary case — a SQL change obliging a SQL review — and
 * interrupting for it would train the reflex of clicking through, which is exactly
 * what makes the fifth one dangerous. The number is small because the cost is per
 * stage, not per prompt.
 */
export const RULE_CONFIRM_THRESHOLD = 2;

export function needsRuleConfirmation(added: readonly TaskStage[]): boolean {
  return added.length > RULE_CONFIRM_THRESHOLD;
}

/**
 * What to put in front of the user: what is being added, and on what evidence.
 *
 * The evidence is the point. "Add 5 reviews?" is unanswerable; "ETL reliability
 * review, because 412 changed paths matched" is a question with an obvious answer
 * when the paths are wrong.
 */
export function describeRuleAdditions(
  added: readonly TaskStage[],
  matches: readonly RuleMatch[],
): string {
  const byStageId = new Map(
    matches.map((match) => [match.rule.stage.id, match] as const),
  );
  return added
    .map((stage) => {
      const match = byStageId.get(stage.id);
      const paths = match?.matchedPaths ?? [];
      const example = paths[0] ? ` e.g. ${paths[0]}` : "";
      return (
        `• ${stage.name} — ${match?.rule.reason ?? "a rule matched"} ` +
        `(${paths.length} path(s)${example})`
      );
    })
    .join("\n");
}
