import { Result, err, ok } from "../utilities/result";
import { briefFault } from "./correctionBrief";
import {
  answerQuestion,
  approveStage,
  correctStage,
  isCorrectable,
  nextAction,
  outstandingDeferrals,
  resolveDeferral,
  retireChecklistItem,
  retryStage,
  setChecklistItem,
  unansweredQuestions,
} from "./pipelineEngine";
import { offeredCheckIds, setItemCoverage, tickAnsweredItems } from "./checkCoverage";
import { checklistGates, gateFor } from "./checklistScope";
import { appendIntervention } from "./interventions";
import { claimAnswers, liveCallOf } from "./hostRequests";
import { pipelineRevision } from "./pipelineRevision";
import { missingPullRequestUrl } from "./pullRequestEvidence";
import { shouldAskForPullRequest } from "./pullRequestWait";
import { formatFindings, parseReviewFindings, summariseFindings } from "./reviewFindings";
import {
  StageDefinitionSource,
  formatSendBackNote,
  refreshPendingStages,
  revertToStage,
  sendBackTargets,
  sendBackToStage,
} from "./stageRefresh";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";
import { TaskWorkspace } from "./taskWorkspace";

/**
 * The decisions a client other than the extension may make about a run, and the
 * conditions under which it may make them.
 *
 * Every operation here is an existing engine transition — `approveStage`,
 * `retryStage`, `setChecklistItem` — wrapped in the checks a second client needs and
 * the extension's own commands get for free from being the only writer:
 *
 * - **Revision.** The decision is about the pipeline the person was shown. If it has
 *   moved since, the write is refused rather than applied to state nobody looked at.
 *   That is also what stops two clients transitioning one gate twice: the first
 *   approval changes the revision the second one carries.
 * - **In flight.** A subtask marked `active` means a session is running, and the
 *   runner holding it saves its own in-memory pipeline when it settles — so a write
 *   from here would be overwritten without trace. Refused, and said so.
 *
 * Pure, and decided against the task *as read inside the write*
 * (`TaskRepository.update`), never against a copy fetched earlier.
 *
 * Correcting, re-running and sending back are here too. Each takes what the
 * extension's dialogs would ask for — a finding, a reason, a target — as arguments
 * the person supplies, and nothing is chosen for them: a send-back's target must be
 * one the route offers, picked by the person.
 *
 * Answering and advancing are requests: `hostRequests.ts` is how the extension
 * serves them, since only it can finish either.
 *
 * Deliberately absent: stop. It is killing a process another host owns.
 */

export type ControlRefusal =
  | { kind: "unknownTask"; message: string }
  | { kind: "noPipeline"; message: string }
  | { kind: "unknownStage"; message: string }
  | { kind: "stale"; message: string }
  | { kind: "inFlight"; message: string }
  | { kind: "notRetryable"; message: string }
  | { kind: "needsPullRequest"; message: string }
  | { kind: "notCorrectable"; message: string }
  | { kind: "weakBrief"; message: string }
  /** The worktree holds uncommitted changes, which removing it would discard. */
  | { kind: "dirty"; message: string; changedFileCount: number }
  /** Git would not remove the worktree; the task can still be untracked. */
  | { kind: "removalFailed"; message: string }
  | { kind: "refused"; message: string };

export interface ControlOutcome {
  task: TaskWorkspace;
  /**
   * False when the requested outcome already held and nothing was written — the same
   * button pressed twice, or pressed in two clients. Reported rather than refused,
   * because the person asked for a state and the state is what they asked for.
   */
  changed: boolean;
  message: string;
  /**
   * Set when a decision left the route ready to carry on — answers that went into the
   * brief — so the caller can start the next advance if the operator has asked for
   * that. Never decided here: whether to advance after answering is a setting.
   */
  readyToAdvance?: boolean;
}

export interface ApprovalRequest {
  stageId: string;
  /** `pipelineRevision` of the pipeline the decision was made against. */
  revision: string;
  note?: string;
  at: string;
}

export interface RetryRequest {
  stageId: string;
  revision: string;
  at: string;
}

export interface ChecklistRequest {
  itemId: string;
  checked: boolean;
  at: string;
}

export interface CorrectionRequest {
  stageId: string;
  revision: string;
  /** The whole brief the correction session gets, so it is held to `briefFault`. */
  finding: string;
  at: string;
}

export interface RerunRequest {
  stageId: string;
  revision: string;
  /** Why, handed to the new session as stage-scoped guidance. Optional, as in the extension. */
  reason?: string;
  at: string;
  /** Current config, so the stages that re-open run with current instructions. */
  definitions?: StageDefinitionSource;
}

export interface SendBackRequest {
  /** The stage whose findings these are. */
  fromStageId: string;
  /** Where they go; must be one `sendBackTargets` offers. */
  targetStageId: string;
  revision: string;
  /** Fix keeps the target's work and corrects it; rerun discards it. */
  how: "fix" | "rerun";
  /**
   * What went wrong, used only when the stage recorded nothing to send. A human gate
   * has no reply, and it is the one stage where a person is the source of the finding.
   */
  findings?: string;
  note?: string;
  at: string;
  definitions?: StageDefinitionSource;
}

/** Everything a stage's subtasks reported, which is where findings live. */
export function stageFindings(stage: TaskStage): string {
  return stage.subtasks
    .map((subtask) => subtask.reply?.trim())
    .filter((reply): reply is string => !!reply)
    .join("\n\n");
}

/** A stage the extension offers **Retry This Stage** on; see `stagePresentation`. */
export function isRetryable(stage: TaskStage): boolean {
  if (stage.status === "failed") return true;
  return stage.status === "active" && stage.subtasks.some((s) => s.status === "failed");
}

/** A session is running for this pipeline right now, as far as the state file says. */
export function sessionInFlight(pipeline: TaskPipeline): TaskStage | undefined {
  return pipeline.stages.find((stage) => stage.subtasks.some((s) => s.status === "active"));
}

export function decideApproval(
  task: TaskWorkspace | undefined,
  request: ApprovalRequest,
): Result<ControlOutcome, ControlRefusal> {
  const located = locate(task, request.stageId);
  if (!located.ok) return located;
  const { pipeline, stage } = located.value;

  // Checked before the revision: an approval that already happened changed the
  // revision, so the second press would otherwise read as "someone else moved it".
  if (stage.status === "passed") {
    return ok({
      task: task!,
      changed: false,
      message: `"${stage.name}" is already approved.`,
    });
  }

  const guarded = guard(pipeline, request.revision);
  if (!guarded.ok) return guarded;

  // The extension asks for the URL in a dialog at this point. There is nothing here
  // to ask with, and approving past it would advance onto a target branch that may
  // not have the work — the outcome the hold exists to prevent.
  if (
    shouldAskForPullRequest({
      requiresPullRequest: stage.requiresPullRequest,
      reportedNone: missingPullRequestUrl(stage),
      stageId: stage.id,
      waits: pipeline.pullRequests,
    })
  ) {
    return err({
      kind: "needsPullRequest",
      message:
        `"${stage.name}" reported no pull request URL, and approving it needs one. ` +
        "Approve it in VS Code, which asks for the link.",
    });
  }

  const approved = approveStage(pipeline, stage.id, request.at, request.note?.trim() || undefined);
  if (!approved.ok) return err({ kind: "refused", message: approved.error.message });

  return ok({
    task: withPipeline(task!, approved.value, request.at),
    changed: true,
    message: `Approved "${stage.name}".`,
    readyToAdvance: hasWorkToRun(approved.value),
  });
}

/**
 * Whether an advance would run something. After a decision this is what separates
 * "the route can continue" from "it stops at the next gate, or is finished", and
 * starting a runner for the second spends a process to stop where it already is.
 */
function hasWorkToRun(pipeline: TaskPipeline): boolean {
  const next = nextAction(pipeline).kind;
  return next === "run" || next === "split";
}

export function decideRetry(
  task: TaskWorkspace | undefined,
  request: RetryRequest,
): Result<ControlOutcome, ControlRefusal> {
  const located = locate(task, request.stageId);
  if (!located.ok) return located;
  const { pipeline, stage } = located.value;

  const guarded = guard(pipeline, request.revision);
  if (!guarded.ok) return guarded;

  // `retryStage` resets whatever it is given, so the status check is the only thing
  // standing between a stale button and re-opening a stage that has since passed.
  if (!isRetryable(stage)) {
    return err({
      kind: "notRetryable",
      message: `"${stage.name}" is ${stage.status}; only a failed stage can be retried.`,
    });
  }

  const retried = retryStage(pipeline, stage.id, request.at);
  if (!retried.ok) return err({ kind: "refused", message: retried.error.message });

  return ok({
    task: withPipeline(task!, retried.value, request.at),
    changed: true,
    message:
      `"${stage.name}" will run again at the next Advance Route. ` +
      "Nothing after it was touched.",
  });
}

/**
 * **Fix This Stage**: one more session that changes only what the finding names and
 * keeps everything the stage already produced. `correctStage` re-opens the later
 * stages that ran — the engine's rule, not this module's.
 */
export function decideCorrection(
  task: TaskWorkspace | undefined,
  request: CorrectionRequest,
): Result<ControlOutcome, ControlRefusal> {
  const located = locate(task, request.stageId);
  if (!located.ok) return located;
  const { pipeline, stage } = located.value;

  const guarded = guard(pipeline, request.revision);
  if (!guarded.ok) return guarded;

  const fault = briefFault(request.finding);
  if (fault) return err({ kind: "weakBrief", message: fault });
  if (!isCorrectable(stage)) {
    return err({
      kind: "notCorrectable",
      message: `"${stage.name}" has produced nothing to correct. Re-run it instead.`,
    });
  }

  const reopened = laterStagesThatRan(pipeline, stage.id);
  const corrected = correctStage(pipeline, stage.id, {
    finding: request.finding.trim(),
    at: request.at,
  });
  if (!corrected.ok) return err({ kind: "refused", message: corrected.error.message });

  return ok({
    task: withPipeline(task!, corrected.value, request.at),
    changed: true,
    message:
      `"${stage.name}" will fix that on the next advance` +
      (reopened > 0 ? `; ${reopened} later stage(s) re-opened.` : "."),
  });
}

/**
 * **Re-run This Stage**: discards it and everything after it. `revertToStage` files
 * the reason as stage-scoped guidance, and the re-opened stages reload their
 * instructions from current config, as the extension's command does.
 */
export function decideRerun(
  task: TaskWorkspace | undefined,
  request: RerunRequest,
): Result<ControlOutcome, ControlRefusal> {
  const located = locate(task, request.stageId);
  if (!located.ok) return located;
  const { pipeline, stage } = located.value;

  const guarded = guard(pipeline, request.revision);
  if (!guarded.ok) return guarded;

  const reverted = revertToStage(pipeline, stage.id, {
    at: request.at,
    reason: "re-run by hand",
    note: request.reason?.trim() || undefined,
  });
  if (!reverted) return err({ kind: "refused", message: `"${stage.name}" cannot be re-run.` });
  const refreshed = request.definitions
    ? refreshPendingStages(reverted.pipeline, request.definitions).pipeline
    : reverted.pipeline;

  return ok({
    task: withPipeline(task!, refreshed, request.at),
    changed: true,
    message:
      `Re-opened ${reverted.reopened.length} stage(s) from "${stage.name}"; ` +
      "they run at the next advance.",
  });
}

/**
 * **Send Back**: a later stage's findings, sent to an earlier stage the route allows.
 * This is the extension's command without its dialogs: the target and whether to fix
 * or re-run are the person's choice, passed in and checked against what the route
 * offers.
 */
export function decideSendBack(
  task: TaskWorkspace | undefined,
  request: SendBackRequest,
): Result<ControlOutcome, ControlRefusal> {
  const located = locate(task, request.fromStageId);
  if (!located.ok) return located;
  const { pipeline, stage: from } = located.value;

  const guarded = guard(pipeline, request.revision);
  if (!guarded.ok) return guarded;

  const target = sendBackTargets(pipeline, from.id).find((s) => s.id === request.targetStageId);
  if (!target) {
    return err({
      kind: "refused",
      message: `The route does not let "${from.name}" send work back to that stage.`,
    });
  }

  const raw = stageFindings(from) || request.findings?.trim() || "";
  if (!raw) {
    return err({
      kind: "weakBrief",
      message: `"${from.name}" recorded nothing to send. Say what went wrong.`,
    });
  }
  // Use the parsed form when parsing found findings, so the stage reads a tidy list.
  // Otherwise send the text verbatim, so a parser that found nothing cannot drop it.
  const parsed = parseReviewFindings(raw);
  const findings = parsed.length > 0 ? formatFindings(parsed) : raw;
  const summary = summariseFindings(parsed) ?? "the stage's report";

  if (request.how === "fix") {
    if (!isCorrectable(target)) {
      return err({
        kind: "notCorrectable",
        message: `"${target.name}" has produced nothing to fix. Send it back to re-run instead.`,
      });
    }
    const corrected = correctStage(pipeline, target.id, {
      finding: formatSendBackNote(from.name, findings, request.note),
      at: request.at,
      title: `Fix: ${summary}`,
    });
    if (!corrected.ok) return err({ kind: "refused", message: corrected.error.message });
    return ok({
      task: withPipeline(task!, corrected.value, request.at),
      changed: true,
      message: `"${target.name}" will fix ${summary} on the next advance.`,
      readyToAdvance: hasWorkToRun(corrected.value),
    });
  }

  const sent = sendBackToStage(pipeline, {
    targetStageId: target.id,
    fromStageId: from.id,
    findings,
    note: request.note,
    at: request.at,
  });
  if (!sent) return err({ kind: "refused", message: `Could not send back to "${target.name}".` });
  const refreshed = request.definitions
    ? refreshPendingStages(sent.pipeline, request.definitions).pipeline
    : sent.pipeline;
  return ok({
    task: withPipeline(task!, refreshed, request.at),
    changed: true,
    message: `Sent ${summary} back to "${target.name}"; ${sent.reopened.length} stage(s) re-opened.`,
    readyToAdvance: hasWorkToRun(refreshed),
  });
}

export interface AnswerRequest {
  /** Identifies which question was answered, since a new one may have replaced it. */
  askedAt: string;
  /** Item id to answer; every unanswered item must be covered. */
  answers: Record<string, string>;
  at: string;
}

/**
 * Records the answers, and delivers them where this client can.
 *
 * A `NEEDS-INFO` question's answers go into the brief here and now: nothing is waiting
 * on them, so they are pure state-file work, and the next advance reads them from the
 * brief. A live question is different — its answers count only when the process
 * holding the `ask_user` call hands them over — so they are marked submitted and that
 * process delivers them (`hostRequests.ts`).
 *
 * No revision and no in-flight refusal, unlike every other decision here: a live
 * question is asked by a running session, so a session in flight is the normal case,
 * and the runner merges its own save with this one rather than overwriting it. The
 * question's `askedAt` is the guard instead — answers to a question that has since
 * been replaced are refused, never applied to the new one.
 */
export function decideAnswers(
  task: TaskWorkspace | undefined,
  request: AnswerRequest,
): Result<ControlOutcome, ControlRefusal> {
  if (!task) return err({ kind: "unknownTask", message: "That task no longer exists." });
  const pipeline = task.pipeline;
  const question = pipeline?.pendingQuestion;
  if (!pipeline || !question || question.askedAt !== request.askedAt) {
    return err({
      kind: "stale",
      message: "That question is no longer waiting. Look again at what the run is asking now.",
    });
  }
  if (question.submittedAt) {
    return ok({ task, changed: false, message: "Already answered; waiting for the stage to receive it." });
  }

  let answered = pipeline;
  for (const [itemId, text] of Object.entries(request.answers)) {
    if (!text.trim()) continue;
    const result = answerQuestion(answered, itemId, text.trim(), request.at);
    if (!result.ok) return err({ kind: "refused", message: result.error.message });
    answered = result.value;
  }
  const missing = unansweredQuestions(answered).length;
  if (missing > 0) {
    return err({ kind: "refused", message: `${missing} question(s) still need an answer.` });
  }

  const submitted = withPipeline(
    task,
    { ...answered, pendingQuestion: { ...answered.pendingQuestion!, submittedAt: request.at } },
    request.at,
  );
  if (liveCallOf(pipeline, question)) {
    return ok({
      task: submitted,
      changed: true,
      message: "Answered. The waiting stage receives it and carries on.",
    });
  }
  const delivered = claimAnswers(submitted, request.at);
  return ok({
    task: delivered?.task ?? submitted,
    changed: true,
    message: "Answered, and added to the brief.",
    readyToAdvance: delivered !== undefined,
  });
}

export interface HeldCallRequest {
  callId: string;
  allow: boolean;
  scope: "once" | "session";
  at: string;
}

/**
 * Records a decision on a call the gate is holding, for the process holding it to
 * apply (`heldCalls.ts`).
 *
 * No revision and no in-flight refusal, for `decideAnswers`' reason: a held call
 * exists only while a session is running, so in flight is the normal case. The call
 * id is the guard — a call no longer mirrored is refused rather than decided.
 */
export function decideHeldCall(
  task: TaskWorkspace | undefined,
  request: HeldCallRequest,
): Result<ControlOutcome, ControlRefusal> {
  if (!task) return err({ kind: "unknownTask", message: "That task no longer exists." });
  const pipeline = task.pipeline;
  const call = pipeline?.heldCalls?.find((candidate) => candidate.id === request.callId);
  if (!pipeline || !call) {
    return err({
      kind: "stale",
      message: "That call is no longer waiting — the stage moved on or timed out.",
    });
  }
  if (call.decision) {
    return ok({ task, changed: false, message: "Already decided; waiting for the stage to receive it." });
  }
  const decision = { allow: request.allow, scope: request.scope, at: request.at };
  return ok({
    task: withPipeline(
      task,
      {
        ...pipeline,
        heldCalls: pipeline.heldCalls!.map((candidate) =>
          candidate.id === call.id ? { ...candidate, decision } : candidate,
        ),
      },
      request.at,
    ),
    changed: true,
    message: request.allow
      ? `Allowed ${call.tool}${request.scope === "session" ? " for the rest of this run" : ""}. The stage carries on.`
      : `Denied ${call.tool}. The stage is told why and carries on.`,
  });
}

/**
 * Ticking an item states a fact — "this behaviour was confirmed" — so it carries no
 * revision: setting it to the value it already has is a no-op, and setting it again
 * after somebody else changed something unrelated is still the same statement.
 */
export function decideChecklistItem(
  task: TaskWorkspace | undefined,
  request: ChecklistRequest,
): Result<ControlOutcome, ControlRefusal> {
  if (!task) return err({ kind: "unknownTask", message: "That task no longer exists." });
  const pipeline = task.pipeline;
  if (!pipeline) {
    return err({ kind: "noPipeline", message: `"${task.name}" has no route attached.` });
  }

  const item = pipeline.stages
    .flatMap((stage) => stage.checklist ?? [])
    .find((candidate) => candidate.id === request.itemId);
  if (!item) {
    return err({ kind: "refused", message: "That checklist item no longer exists." });
  }
  if (item.checked === request.checked) {
    return ok({
      task,
      changed: false,
      message: request.checked ? "Already ticked." : "Already unticked.",
    });
  }

  const running = sessionInFlight(pipeline);
  if (running) return err(inFlight(running));

  const updated = setChecklistItem(pipeline, request.itemId, {
    checked: request.checked,
    at: request.at,
  });
  if (!updated.ok) return err({ kind: "refused", message: updated.error.message });

  return ok({
    task: withPipeline(task, updated.value, request.at),
    changed: true,
    message: request.checked ? "Ticked." : "Unticked.",
  });
}

export interface DeferralRequest {
  itemId: string;
  /** Who owns the work, or why it needs nobody. Required: it is what was missing. */
  resolution: string;
  at: string;
}

/**
 * Settles one item a stage declined as belonging to no stage.
 *
 * One item per call, where VS Code walks every outstanding one in a row of input boxes:
 * a dashboard shows them side by side, so each gets its own box and its own answer. A
 * reason is required for the reason `resolveDeferral` gives — what was missing when
 * every stage declined the work is the knowledge of who owns it, and silence reproduces
 * the gap.
 */
export function decideDeferral(
  task: TaskWorkspace | undefined,
  request: DeferralRequest,
): Result<ControlOutcome, ControlRefusal> {
  const found = withRoute(task);
  if (!found.ok) return found;
  const { task: current, pipeline } = found.value;
  if (!request.resolution.trim()) {
    return err({
      kind: "refused",
      message: "Say who owns this, or why it needs nobody. That is the thing that was missing.",
    });
  }
  if (!outstandingDeferrals(pipeline).some((item) => item.id === request.itemId)) {
    return ok({ task: current, changed: false, message: "That item is already settled." });
  }
  const running = sessionInFlight(pipeline);
  if (running) return err(inFlight(running));

  const settled = resolveDeferral(pipeline, request.itemId, {
    resolution: request.resolution,
    at: request.at,
  });
  if (!settled.ok) return err({ kind: "refused", message: settled.error.message });
  const left = outstandingDeferrals(settled.value).length;
  return ok({
    task: withPipeline(current, settled.value, request.at),
    changed: true,
    message: left > 0 ? `Settled. ${left} still outstanding.` : "Settled. Nothing else is outstanding.",
    // Only a route this item was holding is ready to carry on. Settling the last item
    // raised by a stage still at its gate releases nothing, and starting a runner then
    // would spend a process to stop at the same gate.
    readyToAdvance:
      nextAction(pipeline).kind === "deferredWork" &&
      nextAction(settled.value).kind !== "deferredWork",
  });
}

export interface ItemRetirementRequest {
  itemId: string;
  /** Why nothing can answer the item. Required, and kept with it on the report. */
  reason: string;
  at: string;
}

/**
 * Withdraws a verification item nothing can answer, with the reason.
 *
 * The operator's act, never a stage's — a gate that may withdraw its own questions
 * passes trivially. Counted as its own intervention, because a route accumulating these
 * is one whose review writes items nothing can answer, a different fix from one that
 * asks too much.
 */
export function decideItemRetirement(
  task: TaskWorkspace | undefined,
  request: ItemRetirementRequest,
): Result<ControlOutcome, ControlRefusal> {
  const found = withItem(task, request.itemId);
  if (!found.ok) return found;
  const { task: current, pipeline, item } = found.value;
  if (item.retired) return ok({ task: current, changed: false, message: "Already withdrawn." });
  const running = sessionInFlight(pipeline);
  if (running) return err(inFlight(running));

  const retired = retireChecklistItem(pipeline, request.itemId, {
    reason: request.reason,
    at: request.at,
  });
  if (!retired.ok) return err({ kind: "refused", message: retired.error.message });
  return ok({
    task: withPipeline(
      current,
      {
        ...retired.value,
        interventions: appendIntervention(retired.value.interventions, {
          kind: "retirement",
          stageId: item.raisedByStage,
          at: request.at,
        }),
      },
      request.at,
    ),
    changed: true,
    message: "Withdrawn. The gate no longer holds on it, and the reason stays on the report.",
  });
}

export interface ItemNoteRequest {
  itemId: string;
  /** What was observed. Empty clears an existing note. */
  note: string;
  at: string;
}

/**
 * Records what was observed while verifying an item, without changing whether it is
 * ticked — quietly ticking an item because its note was edited would put evidence
 * against work nobody verified.
 */
export function decideItemNote(
  task: TaskWorkspace | undefined,
  request: ItemNoteRequest,
): Result<ControlOutcome, ControlRefusal> {
  const found = withItem(task, request.itemId);
  if (!found.ok) return found;
  const { task: current, pipeline, item } = found.value;
  const note = request.note.trim();
  if ((item.note ?? "") === note) return ok({ task: current, changed: false, message: "No change." });
  const running = sessionInFlight(pipeline);
  if (running) return err(inFlight(running));

  const updated = setChecklistItem(pipeline, request.itemId, {
    checked: item.checked,
    note,
    at: item.checkedAt ?? request.at,
  });
  if (!updated.ok) return err({ kind: "refused", message: updated.error.message });
  return ok({
    task: withPipeline(current, updated.value, request.at),
    changed: true,
    message: note ? "Note saved." : "Note cleared.",
  });
}

export interface ItemCoverageRequest {
  itemId: string;
  /** The check that answers the item, or undefined to record that nothing does. */
  checkId?: string;
  at: string;
}

/**
 * Names the check that answers an item, and ticks it at once if that check passed.
 *
 * Only a check the item's gate has recorded an outcome for may be named: an item naming
 * a check that does not run reports as unverified rather than as the gap it is. The gate
 * is the one the item's scope sends it to, not the stage that raised it, since on a
 * route with two verifications those are different stages with different checks.
 */
export function decideItemCoverage(
  task: TaskWorkspace | undefined,
  request: ItemCoverageRequest,
): Result<ControlOutcome, ControlRefusal> {
  const found = withItem(task, request.itemId);
  if (!found.ok) return found;
  const { task: current, pipeline, item } = found.value;
  if (item.coveredBy === request.checkId) {
    return ok({ task: current, changed: false, message: "No change." });
  }
  const gate = gateFor(checklistGates(pipeline), item.scope);
  const stage = gate && pipeline.stages.find((s) => s.id === gate.stageId);
  if (request.checkId !== undefined && !offeredCheckIds(stage).some((o) => o.id === request.checkId)) {
    return err({
      kind: "refused",
      message: gate
        ? `"${gate.stageName}" has recorded no outcome for a check "${request.checkId}". ` +
          "Run its check first, then attach one it ran."
        : "This item has no verification gate to attach a check from.",
    });
  }
  const running = sessionInFlight(pipeline);
  if (running) return err(inFlight(running));

  let updated = setItemCoverage(pipeline, request.itemId, request.checkId);
  const settled = gate ? tickAnsweredItems(updated, gate.stageId, request.at) : undefined;
  if (settled) updated = settled.pipeline;
  const ticked = settled?.ticked.some((candidate) => candidate.id === request.itemId) ?? false;
  return ok({
    task: withPipeline(current, updated, request.at),
    changed: true,
    message:
      request.checkId === undefined
        ? "Recorded as a gap: nothing automated answers it, so it stays for a person."
        : ticked
          ? `Ticked: "${request.checkId}" has already passed.`
          : `Attached to "${request.checkId}". It ticks when that check passes.`,
  });
}

function withRoute(
  task: TaskWorkspace | undefined,
): Result<{ task: TaskWorkspace; pipeline: TaskPipeline }, ControlRefusal> {
  if (!task) return err({ kind: "unknownTask", message: "That task no longer exists." });
  if (!task.pipeline) {
    return err({ kind: "noPipeline", message: `"${task.name}" has no route attached.` });
  }
  return ok({ task, pipeline: task.pipeline });
}

function withItem(
  task: TaskWorkspace | undefined,
  itemId: string,
): Result<{ task: TaskWorkspace; pipeline: TaskPipeline; item: ChecklistItem }, ControlRefusal> {
  const found = withRoute(task);
  if (!found.ok) return found;
  const item = found.value.pipeline.stages
    .flatMap((stage) => stage.checklist ?? [])
    .find((candidate) => candidate.id === itemId);
  if (!item) return err({ kind: "refused", message: "That checklist item no longer exists." });
  return ok({ ...found.value, item });
}

function locate(
  task: TaskWorkspace | undefined,
  stageId: string,
): Result<{ pipeline: TaskPipeline; stage: TaskStage }, ControlRefusal> {
  if (!task) return err({ kind: "unknownTask", message: "That task no longer exists." });
  if (!task.pipeline) {
    return err({ kind: "noPipeline", message: `"${task.name}" has no route attached.` });
  }
  const stage = task.pipeline.stages.find((s) => s.id === stageId);
  if (!stage) {
    return err({ kind: "unknownStage", message: `No stage "${stageId}" on "${task.name}".` });
  }
  return ok({ pipeline: task.pipeline, stage });
}

function guard(pipeline: TaskPipeline, revision: string): Result<void, ControlRefusal> {
  if (pipelineRevision(pipeline) !== revision) {
    return err({
      kind: "stale",
      message:
        "This run changed since it was shown, so nothing was done. " +
        "Look at it again and decide on what is there now.",
    });
  }
  const running = sessionInFlight(pipeline);
  if (running) return err(inFlight(running));
  return ok(undefined);
}

function laterStagesThatRan(pipeline: TaskPipeline, stageId: string): number {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  return pipeline.stages.slice(index + 1).filter((s) => s.status !== "pending").length;
}

function inFlight(stage: TaskStage): ControlRefusal {
  return {
    kind: "inFlight",
    message:
      `A session is running on "${stage.name}", and the runner will save over any ` +
      "change made now. Wait for it to stop, or stop it in VS Code.",
  };
}

function withPipeline(task: TaskWorkspace, pipeline: TaskPipeline, at: string): TaskWorkspace {
  return { ...task, pipeline, updatedAt: at };
}
