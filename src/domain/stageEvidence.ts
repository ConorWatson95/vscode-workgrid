import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * What actually backs a stage's outcome.
 *
 * The weakest link in the harness, and the default for most stages: a stage with no
 * `verify` and no `planFile` passes because its session ended without an error. That
 * is a fact about a process exiting, not about the work — and it was reported in
 * exactly the same words as a stage whose build had gone green.
 *
 * This does not change what passes. It makes the basis legible, so a human at an
 * approval gate knows whether they are ratifying a check or taking an agent's word,
 * and so a route can be read afterwards for which of its stages prove anything.
 *
 * Derived rather than stored: it is a reading of state the pipeline already holds,
 * and a stored copy would go stale the moment a stage is re-opened.
 */

export type EvidenceBasis =
  /** A declared command ran and exited zero. */
  | "verified"
  /** Every numbered step of a plan was accounted for. */
  | "planAccounted"
  /** A review stated a verdict in its own words. */
  | "reviewed"
  /** Never ran; an assessment read it as already done. */
  | "assessed"
  /** The session ended without error, and nothing else. */
  | "selfReported"
  /** Nothing to say yet — the stage has not settled. */
  | "none";

export interface StageEvidence {
  basis: EvidenceBasis;
  /** One sentence naming what backs this stage, for a reader deciding whether to trust it. */
  summary: string;
  /**
   * True when nothing but the agent's own account backs the outcome.
   *
   * Kept as its own flag rather than left as `basis === "selfReported"`, because
   * every caller asks this question and none of them should be re-deriving which of
   * the bases count.
   */
  selfReported: boolean;
}

/** What backs this stage, strongest evidence first. */
export function stageEvidence(stage: TaskStage): StageEvidence {
  // A stage that has not settled has no outcome to back. Said as its own basis
  // rather than as "self-reported", which would accuse a running stage of a claim
  // it has not made.
  if (stage.status !== "passed" && stage.status !== "awaiting-approval" && stage.status !== "skipped") {
    return {
      basis: "none",
      summary: "This stage has not settled, so there is nothing to back yet.",
      selfReported: false,
    };
  }

  if (stage.status === "skipped") {
    return {
      basis: "assessed",
      summary: stage.skipReason
        ? `Skipped, not run — ${stage.skipReason}`
        : "Skipped rather than run, so nothing here was executed or checked.",
      // Not self-reported by *this* stage, because this stage said nothing. It is
      // weaker than any of them, and `skipReason` is where that is spelled out.
      selfReported: false,
    };
  }

  // The check that ran, never the one that was declared. A runner built without a
  // verifier leaves `verify` set and nothing executed, which reads identically.
  const ran = stage.verification;
  if (ran && ran.exitCode === 0) {
    return {
      basis: "verified",
      summary: `\`${ran.command}\` ran and exited 0. Something other than the agent decided this.`,
      selfReported: false,
    };
  }

  const steps = stage.planSteps ?? [];
  if (steps.length > 0 && steps.every((step) => step.status !== "unaccounted")) {
    const done = steps.filter((step) => step.status === "done").length;
    return {
      basis: "planAccounted",
      summary:
        `Every one of ${steps.length} plan step(s) was accounted for (${done} done). ` +
        "Still the agent's account, but a per-step one it cannot pass by staying silent.",
      // Weaker than a build, stronger than a paragraph, and still the agent's word —
      // so it is not marked self-reported only because the accounting is enforced.
      selfReported: false,
    };
  }

  if (stage.verdict) {
    return {
      basis: "reviewed",
      summary:
        stage.verdict === "pass"
          ? "A review stated a verdict of pass on someone else's work."
          : "A review stated a verdict of block.",
      selfReported: false,
    };
  }

  return {
    basis: "selfReported",
    summary: declaredButNotRun(stage)
      ? `This stage declares \`${stage.verify}\`, but no check was recorded as having run — ` +
        "so its outcome rests on the session ending without an error."
      : "Nothing but the agent's own account. The session ended without an error, which " +
        "is what this records — declare a `verify` command or a `planFile` on this stage " +
        "to have something other than the agent decide.",
    selfReported: true,
  };
}

/**
 * A stage that declared a check which left no record of running.
 *
 * Worth distinguishing in the summary because the two self-reported stages need
 * opposite responses: one needs a check written, the other needs the check that
 * exists to be looked into.
 */
function declaredButNotRun(stage: TaskStage): boolean {
  return Boolean(stage.verify) && !stage.verification;
}

/**
 * Every settled stage whose outcome rests on nothing but the agent's account.
 *
 * The route-level question — "how much of this is actually proven?" — which no
 * per-stage line can answer, because the answer is a proportion.
 */
export function selfReportedStages(pipeline: TaskPipeline): TaskStage[] {
  return pipeline.stages.filter((stage) => stageEvidence(stage).selfReported);
}

/**
 * One line for a whole route, or undefined when every settled stage is backed.
 *
 * Undefined rather than "0 stages are self-reported" on purpose: a reassurance
 * printed on every report is read as decoration, and stops being read at all.
 */
export function summariseEvidence(pipeline: TaskPipeline): string | undefined {
  const settled = pipeline.stages.filter(
    (stage) => stageEvidence(stage).basis !== "none",
  );
  const weak = selfReportedStages(pipeline);
  if (settled.length === 0 || weak.length === 0) return undefined;
  return (
    `${weak.length} of ${settled.length} settled stage(s) are self-reported: ` +
    weak.map((stage) => stage.name).join(", ") +
    ". Nothing other than the agent checked them."
  );
}
