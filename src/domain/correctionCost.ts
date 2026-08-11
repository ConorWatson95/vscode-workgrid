import { DiscardedRun, TaskPipeline } from "./taskPipeline";

/**
 * What going backwards actually cost, split by whether the work had to be redone.
 *
 * The ledger (`TaskPipeline.discarded`) already records every run a re-open threw
 * away, which answered "how much"; it could not answer the question that decides
 * whether any of this is worth engineering against — *how much of it was work that
 * was genuinely wrong*. A stage discarded because its own output was defective is
 * cost the route had to pay. A stage discarded for standing downstream of that one
 * may have been perfectly good, and paying for it again is the harness invalidating
 * more than the change warranted.
 *
 * CLAUDE.md asserts that downstream re-opening is affordable, because on a real
 * route most stages after an implementation one are gates, promotions and reviews.
 * That is a claim about the collateral share, and this is the number that settles
 * it. It reports what happened; it recommends nothing.
 *
 * Pure and vscode-free.
 */

/** One backwards step: a correction or a re-run, and everything it discarded. */
export interface CorrectionEvent {
  /** When the stage was re-opened. Groups the ledger entries written together. */
  at: string;
  /** Why, in whatever words the caller recorded. */
  reason?: string;
  /**
   * The stage whose own output was being discarded, when there was one.
   *
   * Absent for a correction: `correctStage` keeps the stage it corrects, so a
   * correction discards collateral only. That absence is the signal that this
   * event was a targeted fix rather than a demolition.
   */
  targetStageName?: string;
  /** Cost of the target's own discarded run. */
  targetCostUsd: number;
  /** Cost of the stages thrown away only for standing after it. */
  collateralCostUsd: number;
  /** Time inside sessions, split the same way, in milliseconds. */
  targetElapsedMs: number;
  collateralElapsedMs: number;
  /** Names of the collateral stages, in route order. */
  collateralStageNames: string[];
}

export interface CorrectionCostSummary {
  events: CorrectionEvent[];
  targetCostUsd: number;
  collateralCostUsd: number;
  targetElapsedMs: number;
  collateralElapsedMs: number;
  /**
   * Collateral as a percentage of all discarded cost, rounded.
   *
   * Undefined when no discarded cost was recorded at all — a route whose runs
   * reported no money would otherwise show 0%, which reads as "no collateral"
   * when it means "nothing measured". The elapsed figures still apply in that
   * case, which is why they are kept separately rather than folded in here.
   */
  collateralShare?: number;
  /** Discarded runs that reported neither cost nor time. */
  unmeasured: number;
}

function isCollateral(run: DiscardedRun): boolean {
  return run.collateral === true;
}

/**
 * Groups the ledger into the backwards steps that wrote it.
 *
 * Keyed on `at`, because both `revertToStage` and `correctStage` stamp every entry
 * of one re-open with the same timestamp — the grouping is a property of how the
 * ledger is written, not a guess. Two re-opens sharing a timestamp to the
 * millisecond would merge, which costs a row in a report and no correctness.
 */
export function correctionEvents(pipeline: TaskPipeline): CorrectionEvent[] {
  const byTime = new Map<string, DiscardedRun[]>();
  for (const run of pipeline.discarded ?? []) {
    const existing = byTime.get(run.at);
    if (existing) existing.push(run);
    else byTime.set(run.at, [run]);
  }

  return [...byTime.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([at, runs]) => {
      const target = runs.find((run) => !isCollateral(run));
      const collateral = runs.filter(isCollateral);
      return {
        at,
        ...(runs[0].reason ? { reason: runs[0].reason } : {}),
        ...(target ? { targetStageName: target.stageName } : {}),
        targetCostUsd: target?.costUsd ?? 0,
        targetElapsedMs: target?.elapsedMs ?? 0,
        collateralCostUsd: sum(collateral, (run) => run.costUsd),
        collateralElapsedMs: sum(collateral, (run) => run.elapsedMs),
        collateralStageNames: collateral.map((run) => run.stageName),
      };
    });
}

export function correctionCost(pipeline: TaskPipeline): CorrectionCostSummary {
  const runs = pipeline.discarded ?? [];
  const collateral = runs.filter(isCollateral);
  const targets = runs.filter((run) => !isCollateral(run));

  const collateralCostUsd = sum(collateral, (run) => run.costUsd);
  const targetCostUsd = sum(targets, (run) => run.costUsd);
  const total = collateralCostUsd + targetCostUsd;

  return {
    events: correctionEvents(pipeline),
    targetCostUsd,
    collateralCostUsd,
    targetElapsedMs: sum(targets, (run) => run.elapsedMs),
    collateralElapsedMs: sum(collateral, (run) => run.elapsedMs),
    ...(total > 0 ? { collateralShare: Math.round((collateralCostUsd / total) * 100) } : {}),
    unmeasured: runs.filter((run) => !run.costUsd && !run.elapsedMs).length,
  };
}

function sum(runs: readonly DiscardedRun[], of: (run: DiscardedRun) => number | undefined): number {
  return runs.reduce((total, run) => total + (of(run) ?? 0), 0);
}
