import { TaskPipeline, TaskStage } from "./taskPipeline";
import { StageAuthority } from "./taskRoute";
import { findingsOfSubtasks, hasBlockingFindings, summariseFindings } from "./reviewFindings";

// Re-exported so callers reason about authority through this module rather than
// reaching into the route types for a concept this one owns.
export type { StageAuthority };

/** Why a gate could not be certified, or what evidence says it can be. */
export interface CertificationVerdict {
  admissible: boolean;
  /** One line, for the log and the stage report. Always present. */
  reason: string;
}

/**
 * Decides whether the harness may pass an approval gate on the strength of evidence.
 *
 * Measured 1 Sep 2026 across 17 pipelines: of 320 approvals, **49** sat on a
 * `humanVerification` or `deployment` stage — the two kinds that can carry a real
 * authority boundary. The other 271 were on planning, implementation, test and review
 * stages, and only 16 approvals in the whole corpus carried an operator note at all. So
 * the overwhelmingly common intervention is a click supplying no information, on a
 * stage whose evidence the harness had already parsed, recorded and rendered.
 *
 * That is the failure this closes, and it is the *opposite* direction from every other
 * check in this domain: those exist to stop a route walking past a problem, and this
 * exists to stop a route stopping when there is none. The cost asymmetry is what makes
 * it admissible — a route held for a click nobody needed to make is what turns an
 * operator into a scheduler, which is the KPI the harness is judged on.
 *
 * What makes this harness certification rather than self-approval: **every input is
 * recorded by something other than the stage's own claim about itself.** The verdict is
 * a parsed marker, the findings are parsed from the reply by machinery the session does
 * not control, the verification is a process exit code, and the deferrals were recorded
 * when they were raised. A stage closing with "suggested approve to continue"
 * contributes nothing here.
 *
 * Rules, each load-bearing:
 *
 * - **Declared, never inferred from the kind.** A `deployment` stage is not
 *   automatically an authority boundary and an `implementation` stage is not
 *   automatically safe: `report-change`'s commit stage ships nothing, while its DEV
 *   merge is the irreversible act. Inferring would be the runtime deciding which of a
 *   project's acts need a human, which only the project knows. Absence means `"human"`,
 *   so nothing that has not opted in changes.
 * - **Anything unproven is a human's.** Every branch below defaults to refusing. A
 *   stage whose evidence could not be read is not a stage with clean evidence — the
 *   rule the unmeasured wait and the unidentifiable process already follow.
 * - **A declared check that did not run refuses the gate**, whatever its exit code
 *   would have been. `TaskStage.verification` is the check that *ran*; `verify` is a
 *   declaration, and `stageEvidence` exists because those two were once conflated. A
 *   gate passed on a check nobody executed is exactly what makes an evidence-based
 *   transition dishonest.
 * - **Blocking findings refuse it even where a verdict passed.** `pipelineRunner` lets
 *   a stated `VERDICT` outrank parsed severities, because a route that stops for
 *   nothing teaches you to click past the stop. That trade is right when the question
 *   is whether to *hold* and wrong here: holding costs a click, passing automatically
 *   over a critical costs the thing the review existed to prevent. So this reads both
 *   and refuses on either. Measured on the same corpus — 11 stages sit settled `passed`
 *   carrying parsed criticals, one of them six.
 * - **The checklist, plan steps and operator actions are not re-checked here.**
 *   `approveStage` already refuses on all three and this only ever runs in front of it,
 *   so repeating them would be a second copy of a rule that has to agree with the
 *   first. Honouring that error is the caller's job, not predicting it.
 */
export function certifyStage(pipeline: TaskPipeline, stageId: string): CertificationVerdict {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage) return refuse("no such stage");

  if (stage.status !== "awaiting-approval") {
    return refuse(`the stage is ${stage.status}, not awaiting approval`);
  }

  // The declaration. Checked first so a route that has not opted in costs nothing to
  // read, and so the reason names the declaration rather than an evidence gap the
  // operator would otherwise go looking for.
  if ((stage.authority ?? "human") !== "evidence") {
    return refuse("this gate is declared a human authority boundary");
  }

  // Two kinds may never be certified, whatever a route declares, and both are refused
  // at parse time as well -- this is the backstop for a pipeline persisted before that
  // rule existed. Neither is a judgement about which acts need a human, which is the
  // thing `authority` exists so the harness does not have to guess: it is that
  // approving these two does something *other* than let the route continue.
  //
  // `assessment` is the sharper of the two. `approveStage` applies its conclusions by
  // marking stages **skipped**, so certifying one automatically would let the route
  // skip stages on an agent's reading of a diff with nobody having read the evidence --
  // which is the precise failure the assessment gate was built to prevent, arriving
  // through the one door left open. `humanVerification` is a gate whose entire meaning
  // is that a person confirmed a behaviour; an empty checklist there means the evidence
  // has not arrived yet, not that there was none to give.
  if (stage.kind === "assessment" || stage.kind === "humanVerification") {
    return refuse(`a ${stage.kind} stage is always a human's, whatever the route declares`);
  }

  // A stage held for findings, a refused correction, an unopened pull request or a
  // missing plan step carries `blocked`. Every one is a statement that the stage did
  // not do what it was asked, and the remedy for each is a human's.
  if (stage.blocked) return refuse(`the stage is held: ${stage.blocked}`);

  if (stage.verdict === "block") return refuse("the review returned VERDICT: block");

  const findings = findingsOfSubtasks(stage.subtasks);
  if (hasBlockingFindings(findings)) {
    return refuse(`the report carries ${summariseFindings(findings) ?? "blocking findings"}`);
  }

  // Declared but never executed. This is the distinction `stageEvidence` was built to
  // keep, and certifying across it would report a stage as evidence-backed on the
  // strength of a string in a config file.
  if (stage.verify && !stage.verification) {
    return refuse("its declared check never ran");
  }
  if (stage.verification && stage.verification.exitCode !== 0) {
    return refuse(`its check exited ${stage.verification.exitCode}`);
  }

  // Work this stage declined as belonging to no stage, still unsettled.
  //
  // Deliberately *not* `outstandingDeferrals`, and the difference is the whole point.
  // That function counts only items whose raising stage has already passed, which at
  // this moment is not true of this one — so it would report nothing right up until
  // the approval that makes the items outstanding. The approval command settles them
  // immediately *after* approving, for exactly that reason, by asking the operator a
  // question per item.
  //
  // An unattended pass is the one path that reaches that point with nobody to ask.
  // Settling a deferral requires a sentence from a person — it is the one thing here
  // that cannot be derived from evidence — so a gate holding unsettled items is a
  // human's, whatever else is clean. Refusing is what routes it back to the operator
  // standing in front of the report that explains it.
  const mine = (pipeline.deferrals ?? []).filter(
    (item) => !item.resolved && item.raisedByStage === stage.id,
  );
  if (mine.length > 0) {
    return refuse(`it declined ${mine.length} item(s) that nobody has settled`);
  }

  return { admissible: true, reason: certifiedBy(stage, findings.length) };
}

/**
 * What backed the certification, for the log and the stage report.
 *
 * Named rather than summarised as "evidence": a reader asking why a gate passed with
 * nobody present is asking exactly this, and "the harness certified it" is the answer
 * that makes an automatic transition look like the harness marking its own homework.
 */
function certifiedBy(stage: TaskStage, findingCount: number): string {
  const parts: string[] = [];
  if (stage.verification) parts.push(`${stage.verification.command} exited 0`);
  if (stage.verdict === "pass") parts.push("the review returned VERDICT: pass");
  if (findingCount > 0) parts.push(`${findingCount} non-blocking finding(s)`);
  if (parts.length === 0) parts.push("nothing outstanding against it");
  return parts.join("; ");
}

function refuse(reason: string): CertificationVerdict {
  return { admissible: false, reason };
}
