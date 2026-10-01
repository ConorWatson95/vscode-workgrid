import { ReviewRule } from "./reviewRules";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * Checklist items left behind by a rule the project no longer declares.
 *
 * Nothing removes a stage from a pipeline, and that is right: a pipeline is a
 * snapshot, the stage ran, it cost money, and its report is the account of what it
 * did. `repositionRuleStages` moves rule stages and never deletes one for the same
 * reason. But a rule-added **behaviour review** does not only occupy a slot — it
 * writes checklist items, and those items gate a human-verification stage that has
 * not run yet. So retracting a rule from `harness.json` leaves every task already in
 * flight holding questions nobody will ever ask again, at a gate that refuses to pass
 * while any is outstanding.
 *
 * Measured on the Pyramid export task: `r-runtime-qa-plan` was retracted after its
 * stated reason — no automated UI checks — was answered by `tools/e2e/Invoke-SiteChecks.ps1`.
 * The stage had already written 7 items onto the local verification gate, so the gate
 * went on demanding them from an operator who had just decided they were not wanted.
 * The only admissible answers were to tick things nobody intended to exercise, or to
 * revert to the review and re-run it — which re-runs the retracted rule's stage and
 * writes the list again.
 *
 * Five rules, each load-bearing:
 *
 * - **Keyed on absence from config, never on the rule no longer matching the diff.**
 *   A rule stops matching routinely, because the diff moved — a stage that dropped
 *   its last `.sql` file has not had its review retracted, and withdrawing on that
 *   basis would quietly discard a real review's findings mid-route. A rule the project
 *   no longer *declares* is a decision somebody made and committed.
 * - **Unchecked items only.** A tick is evidence that somebody looked, and it is the
 *   only record that they did. Retracting a rule says the questions should not have
 *   been asked; it says nothing about the answers already given.
 * - **The stage stays, with its report, its cost and its history.** Withdrawing the
 *   questions is not the same as claiming the stage never ran, and the ticks that
 *   survive are explained by nothing else.
 * - **A command, never a refresh pass.** The three refresh tiers all repair a stage
 *   that has not acted yet; this destroys recorded output. Items disappearing from a
 *   gate mid-route with nobody asking is worse than items an operator disagrees with,
 *   so the operator says when — and the count is named before and after.
 * - **Absence means unchanged.** No rules source, no rule-added stages, or nothing
 *   unchecked yields no change at all.
 *
 * Pure and vscode-free.
 */

/**
 * Whether a loaded rule set may be read as a statement about what the project
 * declares, rather than as a failure to find out.
 *
 * The distinction is the whole safety of this module, and it is the one an unreadable
 * `harness.json` destroys: `loadHarness` answers an unparseable file with *no rules*
 * and a problem, which is indistinguishable from a project that retracted every rule
 * it had. Withdrawing on that basis would empty the checklists of every task in the
 * repository because somebody left a trailing comma. Absence of a config file is the
 * same answer for the same reason — a rule stage in a pipeline with no config to read
 * means the file moved, not that the rule was retracted.
 *
 * The rule an unmeasured wait already follows: absence of measurement is not
 * permission to act.
 */
export function rulesAreAuthoritative(source: {
  sourcePath?: string;
  problems: readonly string[];
}): boolean {
  return source.sourcePath !== undefined && source.problems.length === 0;
}

/** A rule-added stage the project's current rules no longer declare. */
export interface RetractedRuleStage {
  stageId: string;
  stageName: string;
  /** The rule's reason, as recorded when the stage was spliced in. */
  rule: string;
  /** Unchecked items it raised, which withdrawing would remove. */
  withdrawable: ChecklistItem[];
  /** Items it raised that somebody has already ticked, which are kept. */
  kept: number;
}

/**
 * Every rule-added stage whose id appears in no current rule.
 *
 * Matching is on the stage id among `rule.stage.id`, which is how
 * `stageModelResolution` already identifies a rule-added stage in config — the same
 * lookup, read for a different question. `addedByRule` holds the rule's *reason*
 * rather than its id, so it is reported and never matched on: two rules may share a
 * reason, and a reason is prose somebody edits.
 */
export function retractedRuleStages(
  pipeline: TaskPipeline,
  rules: readonly ReviewRule[],
): RetractedRuleStage[] {
  const declared = new Set(rules.map((rule) => rule.stage.id));

  return pipeline.stages
    .filter((stage) => stage.addedByRule && !declared.has(stage.id))
    .map((stage) => {
      const raised = itemsRaisedBy(pipeline, stage.id);
      return {
        stageId: stage.id,
        stageName: stage.name,
        rule: stage.addedByRule!,
        withdrawable: raised.filter((item) => !item.checked),
        kept: raised.filter((item) => item.checked).length,
      };
    })
    .filter((retracted) => retracted.withdrawable.length > 0 || retracted.kept > 0);
}

/**
 * Removes the unchecked items raised by retracted rules, leaving everything else.
 *
 * Returns `undefined` when there is nothing to withdraw, so a caller can tell "no
 * change" from a pipeline that happens to compare equal.
 */
export function withdrawRetractedItems(
  pipeline: TaskPipeline,
  rules: readonly ReviewRule[],
): { pipeline: TaskPipeline; withdrawn: RetractedRuleStage[] } | undefined {
  const retracted = retractedRuleStages(pipeline, rules).filter(
    (stage) => stage.withdrawable.length > 0,
  );
  if (retracted.length === 0) return undefined;

  // Keyed on the item id rather than the raising stage, because the item is what is
  // being withdrawn and a gate's pooled list may hold items from several stages.
  const withdrawing = new Set(
    retracted.flatMap((stage) => stage.withdrawable.map((item) => item.id)),
  );

  return {
    pipeline: {
      ...pipeline,
      stages: pipeline.stages.map((stage) =>
        stage.checklist
          ? { ...stage, checklist: stage.checklist.filter((item) => !withdrawing.has(item.id)) }
          : stage,
      ),
    },
    withdrawn: retracted,
  };
}

/**
 * Items attributed to one stage, wherever they are held.
 *
 * A behaviour review writes its items onto its own stage, so in practice this is that
 * stage's own list — but `raisedByStage` is what states the attribution, and reading
 * the attribution rather than the location is what keeps this correct if an item ever
 * lands on the gate that reads it.
 */
function itemsRaisedBy(pipeline: TaskPipeline, stageId: string): ChecklistItem[] {
  return pipeline.stages.flatMap((stage: TaskStage) =>
    (stage.checklist ?? []).filter((item) => item.raisedByStage === stageId),
  );
}
