import { parseReviewFindings, summariseFindings } from "./reviewFindings";
import { sendBackTargets } from "./stageRefresh";
import { StageEvidence, stageEvidence } from "./stageEvidence";
import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * What a stage held at an approval gate is asking of you, and what to do about it.
 *
 * The gate used to present one question — approve or not — with the stage's whole
 * reply as the only evidence. So a review that blocked on a wrong stored procedure
 * and a review that passed cleanly arrived looking identical, and deciding meant
 * reading pages of prose to work out which one it was.
 *
 * Pure, and separate from the notification and the report, because both need the
 * same answer and neither should be where the judgement lives.
 */

/** What the gate suggests doing, in the order the buttons should offer it. */
export type ApprovalAction =
  /** Send the findings back to an earlier stage, which is named. */
  | "sendBack"
  /** Accept the findings as read and carry on. */
  | "approve"
  /** Tick outstanding verification items before anything else. */
  | "verify"
  /** Something is blocking with nowhere configured to send it. */
  | "decide";

export interface ApprovalAdvice {
  /** One line: what this stage concluded. */
  headline: string;
  /** The recommendation, phrased as an instruction. */
  suggestion: string;
  action: ApprovalAction;
  /** Stage the findings would go back to, when `action` is "sendBack". */
  sendBackTo?: { id: string; name: string };
  /** Findings summary, e.g. "1 critical, 1 important". Absent when there are none. */
  findings?: string;
  /** Outstanding verification items across the task, for a verification gate. */
  outstanding: number;
  /**
   * Whether the review said so itself.
   *
   * Distinguished because a stated verdict and an inferred one warrant different
   * confidence: the prose inference has been wrong in both directions, and a reader
   * deciding whether to trust the recommendation needs to know which it is.
   */
  stated: boolean;
  /**
   * What backs the outcome you are being asked to ratify.
   *
   * The gate is the one moment where "nothing checked this but the agent" changes
   * what a reader should do, and it was the one place that did not say so: a stage
   * with a green build and a stage that merely exited cleanly both arrived as
   * "finished and reported nothing outstanding".
   */
  evidence: StageEvidence;
}

export function approvalAdvice(
  pipeline: TaskPipeline,
  stage: TaskStage,
): ApprovalAdvice {
  // Added around the judgement rather than inside it: what backs a stage does not
  // change which button to suggest — a blocking review is blocking whether or not a
  // build ran — it changes how much weight to put on the answer.
  return { ...verdictAdvice(pipeline, stage), evidence: stageEvidence(stage) };
}

function verdictAdvice(
  pipeline: TaskPipeline,
  stage: TaskStage,
): Omit<ApprovalAdvice, "evidence"> {
  const findings = parseReviewFindings(
    stage.subtasks.map((subtask) => subtask.reply ?? "").join("\n\n"),
  );
  const summary = summariseFindings(findings);
  const blocking = stage.verdict === "block";
  const outstanding = outstandingItems(pipeline, stage);
  const targets = sendBackTargets(pipeline, stage.id);

  // A verification gate is about evidence, not about a review's opinion, so
  // outstanding items outrank everything: approving over them is the one thing the
  // gate exists to prevent.
  if (stage.kind === "humanVerification" && outstanding > 0) {
    return {
      headline: `${outstanding} verification item(s) still outstanding.`,
      suggestion:
        "Exercise each one and tick it off. The gate cannot pass while any remain.",
      action: "verify",
      findings: summary,
      outstanding,
      stated: false,
    };
  }

  if (blocking || (stage.verdict === undefined && hasBlocking(findings))) {
    const headline = summary
      ? `This review found ${summary}.`
      : "This review said the work should not proceed.";
    if (targets.length > 0) {
      const target = targets[0];
      return {
        headline,
        // Named rather than "an earlier stage": the whole point is that the reader
        // should not have to open a picker to find out what the recommendation means.
        suggestion:
          `Send the findings back to "${target.name}", which re-opens it and ` +
          "everything after it with the findings attached as guidance.",
        action: "sendBack",
        sendBackTo: { id: target.id, name: target.name },
        findings: summary,
        outstanding,
        stated: blocking,
      };
    }
    return {
      headline,
      // Honest about the gap rather than suggesting a button that is not there. A
      // stage with no `sendBackTo` in the route cannot hand work back, and pretending
      // otherwise sends the reader looking for a command that does not exist.
      suggestion:
        "This stage has no send-back target configured, so the choice is to accept " +
        "the findings or fix them yourself before approving. Add `sendBackTo` to " +
        "this stage in harness.json to make handing them back a one-click move.",
      action: "decide",
      findings: summary,
      outstanding,
      stated: blocking,
    };
  }

  if (summary) {
    return {
      headline: `This review found ${summary}, none of it blocking.`,
      suggestion: "Read them, then approve to continue.",
      action: "approve",
      findings: summary,
      outstanding,
      stated: stage.verdict === "pass",
    };
  }

  return {
    headline:
      stage.verdict === "pass"
        ? "This review passed the work."
        : "This stage finished and reported nothing outstanding.",
    suggestion: "Approve to continue.",
    action: "approve",
    outstanding,
    stated: stage.verdict === "pass",
  };
}

function hasBlocking(findings: ReturnType<typeof parseReviewFindings>): boolean {
  return findings.some(
    (finding) => finding.severity === "critical" || finding.severity === "important",
  );
}

/**
 * Verification items still unticked across the task.
 *
 * Counted across every stage, not just this one: items are raised by behaviour
 * reviews and consumed at the gate, so the stage holding them is rarely the stage
 * that wrote them. Skipped stages are excluded — their items describe work that is
 * no longer in the task.
 */
function outstandingItems(pipeline: TaskPipeline, stage: TaskStage): number {
  const stages =
    stage.kind === "humanVerification"
      ? pipeline.stages.filter((s) => s.status !== "skipped")
      : [stage];
  return stages
    .flatMap((s) => s.checklist ?? [])
    .filter((item) => !item.checked).length;
}

/** The advice as a markdown block, for the top of a stage report. */
export function formatApprovalAdvice(advice: ApprovalAdvice): string {
  const lines = [
    "## Held for your approval",
    "",
    advice.headline +
      (advice.stated ? "" : " _(read out of the reply — the stage stated no verdict.)_"),
    "",
    `**Suggested:** ${advice.suggestion}`,
  ];
  // Only when it is self-reported. Naming the basis every time would put a line
  // about evidence above a green build, where it adds nothing and trains the reader
  // to skip the paragraph that matters.
  if (advice.evidence.selfReported) {
    lines.push(
      "",
      `⚠ **Self-reported.** ${advice.evidence.summary}`,
    );
  }
  return lines.join("\n");
}
