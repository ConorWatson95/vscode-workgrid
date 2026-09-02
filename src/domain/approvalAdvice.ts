import { outstandingDeferrals } from "./pipelineEngine";
import { ReviewFinding, findingsOfSubtasks, summariseFindings } from "./reviewFindings";
import { citesStageByName } from "./deferralOwnership";
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
  /**
   * Work this stage declined, still without an owner.
   *
   * Surfaced at this gate because this is where it can be settled cheaply. The route
   * only *holds* on deferrals in front of a stage that ships, which is right — but
   * for a long time that hold was also the only place they could be settled, so they
   * accumulated silently and arrived as a dozen questions at the deployment door,
   * hours after the stage that raised them had been read and approved.
   */
  declined: number;
}

export function approvalAdvice(
  pipeline: TaskPipeline,
  stage: TaskStage,
): ApprovalAdvice {
  // Added around the judgement rather than inside it: what backs a stage does not
  // change which button to suggest — a blocking review is blocking whether or not a
  // build ran — it changes how much weight to put on the answer.
  return {
    ...verdictAdvice(pipeline, stage),
    evidence: stageEvidence(stage),
    declined: outstandingDeferrals(pipeline).filter(
      (item) => item.raisedByStage === stage.id,
    ).length,
  };
}

/**
 * The send-back target the blocking findings actually name, if they name one.
 *
 * Reviews here say who owns a finding — "Owned by \"Implement the application\"" — and
 * the suggestion ignored it, offering `sendBackTo`'s first entry instead. On a real gate
 * that meant "send the findings to Navigation and permissions" for a critical about a
 * grid callback in the controller: the operator either notices and opens the picker, or
 * accepts and pays a stage to be told the finding is not its work.
 *
 * Only the blocking findings, and only their own text. A suggestion naming another stage
 * must not redirect a critical, and matching the whole reply would catch every stage a
 * review merely mentions — one here says "stages 5-9 own nav/permissions, and I did not
 * re-audit those", naming three stages it is sending nothing to.
 *
 * Falls back to the positional rule when the findings name nothing, or name more than
 * one stage. A wrong confident target is worse than the old guess, because the operator
 * reads the sentence and trusts it.
 *
 * **The quoted spelling was the only one read, and no prompt asked for it.** This looked
 * for `"Implement the data"` and nothing else, while `deferralInstruction` tells a stage
 * to say who owns the work "in a sentence" and names no form — so the parser read a
 * convention that had never been requested. On NMGB-2822 a SQL review wrote, twice, that
 * a critical was `a plan and data-stage decision, not a review fix`; this matched
 * nothing, and the gate recommended `Implement the application`, the stage whose
 * correction had just triggered the amendment. Both ends are fixed: the prompt asks for
 * the name as `routeStages` lists it, and `citesStageByName` accepts the citation
 * spellings `ownedByPendingStage` already reads. Not widened to partial names — see
 * there for why.
 */
function namedByFindings(
  findings: readonly ReviewFinding[],
  targets: readonly TaskStage[],
): TaskStage | undefined {
  const text = findings
    .filter((f) => f.severity === "critical" || f.severity === "important")
    .map((f) => f.text.toLowerCase())
    .join(" ");
  if (!text) return undefined;
  const named = targets.filter((t) => citesStageByName(text, t.name));
  return named.length === 1 ? named[0] : undefined;
}

function verdictAdvice(
  pipeline: TaskPipeline,
  stage: TaskStage,
): Omit<ApprovalAdvice, "evidence" | "declined"> {
  // Through `findingsOfSubtasks`, which reads the round that stands. Pooling every
  // round inline here — which this did — is the same bug the findings summary had, at
  // a second call site, and the two then contradicted each other on one screen: the
  // report said "1 critical, 4 important, 4 suggestions" while the approval box above
  // it said "10 critical, 24 important, 32 suggestions" about the same ten rounds. The
  // gate is where a person decides whether to send work back, so the inflated number
  // was the one being acted on.
  const findings = findingsOfSubtasks(stage.subtasks);
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
      const target = namedByFindings(findings, targets) ?? targets[0];
      return {
        headline,
        // Named rather than "an earlier stage": the whole point is that the reader
        // should not have to open a picker to find out what the recommendation means.
        // Says what it now does by default. Describing the re-run — which is the
        // option, not the default — made the cheap path invisible at the one moment
        // somebody is deciding whether a finding is worth acting on.
        suggestion:
          `Send the findings to "${target.name}" to fix. It keeps what it built and ` +
          "changes only what these name; re-running it from scratch is offered too.",
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

function hasBlocking(findings: readonly ReviewFinding[]): boolean {
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
  // Said at this gate rather than saved for the deployment door. Answering costs a
  // sentence each while the report is still in front of you; left alone they arrive
  // together, much later, about stages nobody remembers.
  if (advice.declined > 0) {
    lines.push(
      "",
      `**${advice.declined} item(s) this stage declined** are still without an owner. ` +
        "Approving will ask who owns each — a sentence apiece, and the route will " +
        "otherwise stop for them in front of the next stage that ships.",
    );
  }
  return lines.join("\n");
}
