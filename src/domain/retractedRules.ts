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
 * **Every retracted stage is reported, including one that raised nothing.** The filter
 * that used to drop those belonged to withdrawal — where a stage with no items is
 * nothing to act on — and applying it here hid a stage whose only trace was a
 * *deferral* from removal entirely. Callers filter for what they are about to do.
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
    });
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

/**
 * Removes retracted rule stages outright, with everything they raised.
 *
 * **Nothing else in this runtime removes a stage from a pipeline**, and the reason is
 * stated everywhere: a pipeline is a snapshot, the stage ran, it cost money, and its
 * report is the account of what it did. `repositionRuleStages` moves rule stages and
 * deletes none; a stage the route no longer defines holds its index. That rule earns
 * its keep for stages a project still declares.
 *
 * It does not reach a stage whose rule has been **retracted**. The project has said in
 * config that this review should not have been required, so the stage is not history
 * worth keeping — it is a row that explains itself by a rule nobody can now read, and
 * its items pollute every gate they route to. On the Pyramid export task
 * `r-runtime-qa-plan` held **15 items of which 11 named no check at all**, so a gate
 * testing automatic check-driven ticking would have sat holding eleven questions no
 * check could ever answer, and the run would have proved nothing.
 *
 * **The cost, which the caller must state rather than bury:** the stage's report, its
 * cost record and any *ticked* items go with it. That is the whole difference from
 * `withdrawRetractedItems`, which keeps all three — so removal is the deliberate
 * choice and withdrawal is the safe one.
 *
 * Four rules:
 *
 * - **Never a stage in flight.** An `active` stage has a live session whose subtask
 *   would lose its home, and `currentStage` naming a removed id leaves the pipeline
 *   pointing at nothing. Refused per stage with a reason, so a second removable stage
 *   is still removed.
 * - **Its deferrals are settled, not orphaned.** `outstandingDeferrals` requires the
 *   raising stage to be settled, so removing the stage would make its items silently
 *   cease to be outstanding — which is the *hiding* failure `settleDiscardedDeferrals`
 *   was written to end, arrived at from the other side. Settled with a reason, so the
 *   record says what became of them.
 * - **The ledgers are never pruned.** `discarded`, `failures` and `interventions`
 *   record what happened, and it happened. The rule a revert already follows.
 * - **Absence means unchanged**, as everywhere here: nothing retracted, nothing
 *   removable, no change at all.
 */
export function removeRetractedStages(
  pipeline: TaskPipeline,
  rules: readonly ReviewRule[],
  at: string,
):
  | {
      pipeline: TaskPipeline;
      removed: RetractedRuleStage[];
      refused: { stage: RetractedRuleStage; reason: string }[];
    }
  | undefined {
  const retracted = retractedRuleStages(pipeline, rules);
  if (retracted.length === 0) return undefined;

  const removed: RetractedRuleStage[] = [];
  const refused: { stage: RetractedRuleStage; reason: string }[] = [];
  for (const candidate of retracted) {
    const stage = pipeline.stages.find((s) => s.id === candidate.stageId)!;
    const reason = inFlightReason(pipeline, stage);
    if (reason) refused.push({ stage: candidate, reason });
    else removed.push(candidate);
  }
  if (removed.length === 0) return { pipeline, removed, refused };

  const going = new Set(removed.map((stage) => stage.stageId));
  const deferrals = (pipeline.deferrals ?? []).map((item) =>
    item.resolved || !going.has(item.raisedByStage)
      ? item
      : {
          ...item,
          resolved: true,
          resolution:
            "Raised by a review the project has since retracted, and the stage was " +
            "removed with it.",
          resolvedAt: at,
        },
  );

  return {
    pipeline: {
      ...pipeline,
      stages: pipeline.stages
        .filter((stage) => !going.has(stage.id))
        // An item raised by a removed stage may have been recorded on another stage's
        // list; attribution is what decides, exactly as it does for withdrawal.
        .map((stage) =>
          stage.checklist
            ? {
                ...stage,
                checklist: stage.checklist.filter(
                  (item) => !going.has(item.raisedByStage),
                ),
              }
            : stage,
        ),
      ...(pipeline.deferrals ? { deferrals } : {}),
    },
    removed,
    refused,
  };
}

/** Why this stage may not be removed, or undefined when it may. */
function inFlightReason(
  pipeline: TaskPipeline,
  stage: TaskStage,
): string | undefined {
  if (stage.status === "active") return "a session is running in it";
  if (pipeline.currentStage === stage.id) return "the route is currently on it";
  if (stage.subtasks.some((subtask) => subtask.status === "active")) {
    return "one of its subtasks is running";
  }
  return undefined;
}
