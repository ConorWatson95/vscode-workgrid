import { Result, err, ok } from "../utilities/result";
import { briefFault } from "./correctionBrief";
import {
  answerQuestion,
  approveStage,
  correctStage,
  isCorrectable,
  retryStage,
  setChecklistItem,
  unansweredQuestions,
} from "./pipelineEngine";
import { claimAnswers } from "./hostRequests";
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
import { TaskPipeline, TaskStage } from "./taskPipeline";
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
  });
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
  if (question.liveCallId) {
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
