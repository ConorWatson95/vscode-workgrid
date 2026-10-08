import { Result, err, ok } from "../utilities/result";
import { approveStage, retryStage, setChecklistItem } from "./pipelineEngine";
import { pipelineRevision } from "./pipelineRevision";
import { missingPullRequestUrl } from "./pullRequestEvidence";
import { shouldAskForPullRequest } from "./pullRequestWait";
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
 * Deliberately absent: stop, reject, re-run, correct. Stopping is killing a process
 * another host owns, and the others need a target or a reason chosen with judgement
 * the extension's dialogs supply. None has an engine transition a button can map to
 * without inventing policy, so none is offered.
 */

export type ControlRefusal =
  | { kind: "unknownTask"; message: string }
  | { kind: "noPipeline"; message: string }
  | { kind: "unknownStage"; message: string }
  | { kind: "stale"; message: string }
  | { kind: "inFlight"; message: string }
  | { kind: "notRetryable"; message: string }
  | { kind: "needsPullRequest"; message: string }
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
