import { EvidenceBasis, StageEvidence, stageEvidence } from "./stageEvidence";
import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * What an approval gate is actually ratifying, and what the weakest thing in it is
 * backed by.
 *
 * `stageEvidence` exists because a stage with no `verify` passes when its session ends
 * without an error, which is a fact about a process exiting rather than about the work
 * -- and the gate was the one place that did not say so. That was right, and it was
 * applied one stage too narrowly: `approvalAdvice` reads the evidence for **the gate
 * stage itself**.
 *
 * A gate is not a judgement about one stage. It is the moment a person accepts
 * everything that has happened since the last gate, and the stages in between are
 * exactly the ones nobody has looked at yet. So the honest question at a gate is not
 * "what backs this stage" but "what is the weakest thing I am about to accept".
 *
 * NMGB-2814 is the case. `rc-uat-promote` had no `verify` at all, so what backed the
 * promotion of a ticket to UAT was the agent's own report that it had gone well. It had
 * not: the promotion was authored as a whole-file csproj copy, which took UAT down for a
 * day, and the acceptance gate that followed presented exactly as a gate following a
 * green build does. The information needed to hesitate was already in the pipeline and
 * was never put in front of anybody.
 *
 * This changes nothing about what passes. It changes what the gate says it is asking.
 */

/** Weakest first. A gate is read for its weakest link, so this is the order that matters. */
const WEAKNESS: readonly EvidenceBasis[] = [
  "selfReported",
  "assessed",
  "reviewed",
  "planAccounted",
  "verified",
  // Last deliberately. A stage that has not settled has made no claim, so it cannot be
  // the weakest thing being ratified -- and ranking it as weak would put every gate
  // permanently in the warned state, which is how a warning stops being read.
  "none",
];

export interface RatifiedStage {
  stage: TaskStage;
  evidence: StageEvidence;
}

export interface RatifiedEvidence {
  /**
   * The settled stages this approval accepts -- everything since the previous gate,
   * including the gate stage itself.
   */
  stages: RatifiedStage[];
  /**
   * The weakest of them, or undefined when there is nothing settled to rank.
   *
   * Named rather than summarised as a count, because "3 of 7 are self-reported" tells
   * a reader to go looking and a name tells them where.
   */
  weakest?: RatifiedStage;
  /**
   * Settled stages **behind** the gate backed by nothing but the agent's own account.
   *
   * The gate stage itself is excluded, and the live data is why. Every
   * `humanVerification` gate is self-reported by construction -- a person answers it,
   * so there is no command that could back it -- and `approvalAdvice` already prints a
   * self-reported line for the gate stage. Including it made the warning fire on 9 of 9
   * live gates, 3 of them saying nothing except that a human gate is answered by a
   * human. A warning that fires constantly is one people learn to click past, which
   * would cost exactly the stop this exists to create.
   *
   * What is left is the honest question: what am I accepting that nobody has looked at?
   */
  selfReported: RatifiedStage[];
}

/**
 * Where the span being ratified begins.
 *
 * The previous stage carrying an approval gate, exclusive -- that stage was ratified at
 * its own gate and must not be presented for approval twice, which would train the
 * reader to skim a list they have already read.
 *
 * A gate that was *skipped* does not close a span. Nobody looked at it, so the stages
 * before it have still never been accepted by a person, and treating a skip as an
 * approval is precisely the substitution `stageEvidence` keeps `assessed` separate to
 * avoid.
 */
function spanStart(pipeline: TaskPipeline, index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    const stage = pipeline.stages[i];
    if (stage.requiresApproval && stage.status === "passed") return i + 1;
  }
  return 0;
}

/**
 * What the approval of `stageId` accepts, and the weakest evidence in it.
 *
 * Returns an empty span for a stage that is not in the pipeline, rather than throwing:
 * this feeds a gate's presentation, and a tree row that fails to render is worse than
 * one that says less.
 */
export function ratifiedEvidence(
  pipeline: TaskPipeline,
  stageId: string,
): RatifiedEvidence {
  const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
  if (index === -1) return { stages: [], selfReported: [] };

  const stages: RatifiedStage[] = [];
  for (let i = spanStart(pipeline, index); i <= index; i++) {
    const stage = pipeline.stages[i];
    const evidence = stageEvidence(stage);
    // A stage that has not settled is not being ratified -- there is no outcome to
    // accept. Dropped here rather than ranked last, so `stages` is a list a reader can
    // take at face value as "this is what you are accepting".
    if (evidence.basis === "none") continue;
    stages.push({ stage, evidence });
  }

  const ranked = [...stages].sort(
    (a, b) => WEAKNESS.indexOf(a.evidence.basis) - WEAKNESS.indexOf(b.evidence.basis),
  );

  return {
    stages,
    weakest: ranked[0],
    selfReported: stages.filter(
      (entry) => entry.evidence.selfReported && entry.stage.id !== stageId,
    ),
  };
}

/**
 * One line for the gate, or nothing when everything in the span is backed by a check.
 *
 * Silent on a fully backed span, the rule `summariseEvidence` already follows: a
 * reassurance printed at every gate is read as decoration and then not read at all.
 *
 * Counts only the stages behind the gate -- see `RatifiedEvidence.selfReported` for why
 * the gate stage is excluded.
 */
export function summariseRatified(ratified: RatifiedEvidence): string | undefined {
  const weak = ratified.selfReported;
  if (weak.length === 0) return undefined;

  const named = weak.map((entry) => `"${entry.stage.name}"`);
  const list =
    named.length <= 3
      ? named.join(", ")
      : `${named.slice(0, 3).join(", ")} and ${named.length - 3} more`;

  return (
    `Nothing but the agent's own report backs ${list}, ` +
    `${weak.length} of the ${ratified.stages.length} stage(s) this approval accepts. ` +
    "Nobody has looked at them."
  );
}
