/**
 * What a route's failures add up to, and what happened about each of them.
 *
 * `TaskPipeline.failures` exists because `failureReason` lived for one instant and
 * every mechanism that answered a failure cleared it — measured on `qubeautoapp`,
 * 179 failures had happened and the reason for none of them survived. That closed the
 * recording half. This is the reading half: a ledger nothing renders is one nobody
 * re-reads, which is the mistake `TaskPipeline.discarded` made for three weeks after
 * it was added.
 *
 * Derivation only. The rendering lives in `ui/stageReport.ts`, so the counting rules
 * have one definition and are covered by tests that need no `vscode`.
 */

import { FailedRun, FailureDisposition, TaskPipeline, TaskStage } from "./taskPipeline";

/** How a route's failures were answered, and how many were not. */
export interface FailureSummary {
  total: number;
  /** Counts per disposition, in the order they should be read. */
  answered: { disposition: FailureDisposition; times: number }[];
  /**
   * Failures nobody responded to, reported apart from the answered counts.
   *
   * The load-bearing figure, and the reason it is not folded in: an unanswered failure
   * is a stage that stopped and was walked away from, which is a different state from
   * one that was retried and is the state a route's own report never showed. The rule
   * an open gate wait already follows — a growing number folded into a total makes one
   * that reads as the measurement being unreliable.
   */
  unanswered: number;
  /**
   * The stages that failed most, worst first, capped by the caller.
   *
   * By count, never by cost. The ledger records no money — a failure's cost lives in
   * `discarded` if the run was thrown away and nowhere at all if it was repaired — and
   * a "worst" ordered by a figure this module would have to invent is worse than one
   * ordered by the fact it actually holds.
   */
  worst: { stageId: string; stageName: string; times: number }[];
}

/** Dispositions in reading order: what the harness did, then what it gave up on. */
const ORDER: readonly FailureDisposition[] = ["repaired", "retried", "reverted", "transient"];

/**
 * A route's failures, or nothing when it has had none.
 *
 * Undefined rather than a summary of zero, the rule `summariseEvidence` follows: a
 * reassurance printed on every report is read as decoration and then not read at all.
 */
export function summariseFailures(
  pipeline: TaskPipeline | undefined,
  worstLimit = 3,
): FailureSummary | undefined {
  const failures = pipeline?.failures ?? [];
  if (failures.length === 0) return undefined;

  const counts = new Map<FailureDisposition, number>();
  let unanswered = 0;
  for (const entry of failures) {
    if (!entry.disposition) unanswered++;
    else counts.set(entry.disposition, (counts.get(entry.disposition) ?? 0) + 1);
  }

  const byStage = new Map<string, { stageId: string; stageName: string; times: number }>();
  for (const entry of failures) {
    const seen = byStage.get(entry.stageId);
    if (seen) seen.times++;
    else
      byStage.set(entry.stageId, {
        stageId: entry.stageId,
        stageName: entry.stageName,
        times: 1,
      });
  }

  return {
    total: failures.length,
    answered: ORDER.filter((disposition) => counts.has(disposition)).map((disposition) => ({
      disposition,
      times: counts.get(disposition)!,
    })),
    unanswered,
    worst: [...byStage.values()]
      // Ties broken by the order they were first recorded, so the list is stable across
      // renders — `sort` is not guaranteed stable for a comparator that returns 0 on a
      // map iteration whose order is insertion, but the tie is genuine either way and a
      // list that reshuffles between two identical reports reads as data changing.
      .sort((a, b) => b.times - a.times)
      .filter((entry) => entry.times > 1)
      .slice(0, worstLimit),
  };
}

/**
 * One stage's failures that have already been answered.
 *
 * Only the answered ones, and the complement is exactly right rather than merely
 * convenient: every responder that records a disposition also clears the subtask's
 * own `failureReason`, so an *undecided* entry is the live failure the report already
 * shows under "Failed". Rendering both would print the current failure twice and give
 * a reader two counts of the same event.
 */
export function answeredFailures(
  pipeline: TaskPipeline | undefined,
  stage: Pick<TaskStage, "id">,
): FailedRun[] {
  return (pipeline?.failures ?? []).filter(
    (entry) => entry.stageId === stage.id && !!entry.disposition,
  );
}

/**
 * How a disposition should be said out loud.
 *
 * In the domain because the words are the distinction: "repaired" and "retried" are the
 * difference between a loop that carried its finding to the stage that owed it and one
 * that started the same stage again, and a report that blurred them would hide the only
 * thing the ledger was added to measure.
 */
export function describeDisposition(disposition: FailureDisposition): string {
  switch (disposition) {
    case "repaired":
      return "repaired the stage the route says owed it";
    case "retried":
      return "re-ran this stage";
    case "reverted":
      return "discarded this stage and everything after it";
    case "transient":
      return "gave up after the transport kept failing";
  }
}
