import { TaskPipeline } from "./taskPipeline";
import { UsageTotals, pipelineUsage } from "./stageUsage";
import { outstandingChecklist, outstandingDeferrals } from "./pipelineEngine";

/**
 * Compares two sets of route runs on cost *and* on outcome.
 *
 * Built for the question the harness has been able to ask but not answer: does carrying
 * a stage's conclusion forward (`handoff`) cost less than letting the next stage
 * rediscover it? Every number needed is already recorded per subtask — `costUsd`,
 * `tokens`, elapsed — so the missing piece was only a way to read them together.
 *
 * Two properties are the whole point, and both exist because the obvious version of
 * this tool would mislead:
 *
 * - **It compares outcomes alongside cost.** The cheaper arm wins on tokens and can
 *   still lose, because a stage that skipped work, got held, or left deferrals
 *   outstanding spent less by doing less. A comparison on cost alone silently optimises
 *   for routes that do nothing.
 * - **It refuses to name a winner when it cannot honestly do so.** One run per arm
 *   cannot separate an effect from ordinary agent variance, and an arm with unmeasured
 *   subtasks is comparing different amounts of work. In both cases the verdict is
 *   withheld and the reason given, rather than a number presented as a finding.
 *
 * Pure and vscode-free.
 */

export interface ArmOutcome {
  /** Runs in this arm. Below two, no verdict is offered. */
  runs: number;
  usage: UsageTotals;
  /** Subtasks that ended in failure, across every run. */
  failedSubtasks: number;
  /** Stages left awaiting a human, which a clean run does not produce. */
  heldStages: number;
  /** Reviews that returned a blocking verdict. */
  blockingVerdicts: number;
  /** Declined work nobody settled. */
  unresolvedDeferrals: number;
  /** Verification and operator items still outstanding. */
  outstandingChecklistItems: number;
}

export interface ArmComparison {
  a: ArmOutcome;
  b: ArmOutcome;
  /** Fresh input tokens, the figure a rediscovering session actually spends. */
  inputTokenDelta: number;
  costDelta: number;
  elapsedMsDelta: number;
  /**
   * Present only when a verdict can be given honestly. Absent means read `withheld`
   * rather than treating the deltas above as a result.
   */
  cheaperArm?: "a" | "b";
  /** Why no winner was named, in words meant to be shown as they are. */
  withheld?: string;
}

const EMPTY_OUTCOME = (): ArmOutcome => ({
  runs: 0,
  usage: {
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    elapsedMs: 0,
    measured: 0,
    unmeasured: 0,
  },
  failedSubtasks: 0,
  heldStages: 0,
  blockingVerdicts: 0,
  unresolvedDeferrals: 0,
  outstandingChecklistItems: 0,
});

/** Adds up one arm: several runs of the same route under the same configuration. */
export function summariseArm(pipelines: readonly TaskPipeline[]): ArmOutcome {
  const total = EMPTY_OUTCOME();
  total.runs = pipelines.length;

  for (const pipeline of pipelines) {
    const usage = pipelineUsage(pipeline);
    total.usage.costUsd += usage.costUsd;
    total.usage.elapsedMs += usage.elapsedMs;
    total.usage.measured += usage.measured;
    total.usage.unmeasured += usage.unmeasured;
    total.usage.tokens.input += usage.tokens.input;
    total.usage.tokens.output += usage.tokens.output;
    total.usage.tokens.cacheRead += usage.tokens.cacheRead;
    total.usage.tokens.cacheCreation += usage.tokens.cacheCreation;

    for (const stage of pipeline.stages) {
      total.failedSubtasks += stage.subtasks.filter((s) => s.status === "failed").length;
      if (stage.status === "awaiting-approval") total.heldStages += 1;
      if (stage.verdict === "block") total.blockingVerdicts += 1;
    }
    total.unresolvedDeferrals += outstandingDeferrals(pipeline).length;
    total.outstandingChecklistItems += outstandingChecklist(pipeline).length;
  }

  return total;
}

/** True when this arm's runs did the work, so its cost means something. */
function ranCleanly(arm: ArmOutcome): boolean {
  return (
    arm.failedSubtasks === 0 &&
    arm.heldStages === 0 &&
    arm.blockingVerdicts === 0 &&
    arm.unresolvedDeferrals === 0
  );
}

export function compareArms(
  aPipelines: readonly TaskPipeline[],
  bPipelines: readonly TaskPipeline[],
  options: { minimumRuns?: number } = {},
): ArmComparison {
  const minimumRuns = options.minimumRuns ?? 2;
  const a = summariseArm(aPipelines);
  const b = summariseArm(bPipelines);

  const comparison: ArmComparison = {
    a,
    b,
    inputTokenDelta: b.usage.tokens.input - a.usage.tokens.input,
    costDelta: b.usage.costUsd - a.usage.costUsd,
    elapsedMsDelta: b.usage.elapsedMs - a.usage.elapsedMs,
  };

  // Ordered so the most fundamental objection is the one reported: no data beats too
  // little data beats incomparable data.
  if (a.runs === 0 || b.runs === 0) {
    comparison.withheld = "One arm has no runs, so there is nothing to compare.";
    return comparison;
  }
  if (a.runs < minimumRuns || b.runs < minimumRuns) {
    comparison.withheld =
      `Each arm needs at least ${minimumRuns} runs; this has ${a.runs} and ${b.runs}. ` +
      "A single run per arm cannot separate the effect from ordinary agent variance.";
    return comparison;
  }
  if (a.usage.unmeasured > 0 || b.usage.unmeasured > 0) {
    comparison.withheld =
      `${a.usage.unmeasured + b.usage.unmeasured} subtask(s) reported no cost or tokens, ` +
      "so the arms measured different amounts of work.";
    return comparison;
  }
  if (!ranCleanly(a) || !ranCleanly(b)) {
    comparison.withheld =
      "At least one arm did not run cleanly — a failed, held or undeferred run spends " +
      "less by doing less, so its lower cost is not a saving.";
    return comparison;
  }
  if (comparison.inputTokenDelta === 0) {
    comparison.withheld = "Both arms spent the same fresh input tokens.";
    return comparison;
  }

  comparison.cheaperArm = comparison.inputTokenDelta > 0 ? "a" : "b";
  return comparison;
}
