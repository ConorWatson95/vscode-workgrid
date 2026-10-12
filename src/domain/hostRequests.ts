import { clearQuestion, unansweredQuestions } from "./pipelineEngine";
import { PendingQuestion } from "./taskPipeline";
import { TaskWorkspace } from "./taskWorkspace";

/**
 * Answers a second client recorded and could not deliver itself.
 *
 * A live answer counts only when the process holding the `ask_user` call writes it
 * into that call's inbox, which is machine-local storage of whichever process runs
 * the stage. So the client marks the question `submittedAt` in the state file, and
 * the owner, watching that file, delivers it. (Advancing used to be a request here
 * too; a client now starts a headless runner instead — `runner/main.ts`.)
 *
 * **Claimed inside the write, never decided from a read.** Several windows on one
 * repository watch the same file. `claimAnswers` is run inside
 * `TaskRepository.update`, under the cross-process lock, and returns nothing when the
 * request has gone, so exactly one window gets a task back and acts.
 */

/**
 * How long a live question waits for the window that owns its call before any other
 * window delivers the answers into the brief instead.
 *
 * Every window sees the request within a second of it being written, so a call still
 * unclaimed after this is one no running window owns — the session ended, or its
 * window reloaded — which is the case the brief exists for. A window that did not
 * wait would take every live answer away from the session waiting for it.
 */
export const LIVE_GRACE_MS = 30_000;

export type HostAction =
  | { kind: "answerLive"; taskId: string; callId: string }
  | { kind: "answerBrief"; taskId: string };

export interface HostWork {
  actions: HostAction[];
  /** The earliest moment a deferred request becomes this window's to serve. */
  retryAt?: number;
}

/**
 * What this window should do about the requests in `tasks`.
 *
 * `owns` says whether this window holds a live call.
 */
export function hostWork(
  tasks: readonly TaskWorkspace[],
  now: number,
  owns: (callId: string) => boolean,
): HostWork {
  const actions: HostAction[] = [];
  let retryAt: number | undefined;

  for (const task of tasks) {
    const pipeline = task.pipeline;
    if (!pipeline) continue;
    const question = pipeline.pendingQuestion;
    if (question && submitted(question) && unansweredQuestions(pipeline).length === 0) {
      const callId = question.liveCallId;
      if (callId && owns(callId)) {
        actions.push({ kind: "answerLive", taskId: task.id, callId });
      } else if (callId) {
        const due = Date.parse(question.submittedAt!) + LIVE_GRACE_MS;
        if (Number.isNaN(due) || due <= now) actions.push({ kind: "answerBrief", taskId: task.id });
        else retryAt = retryAt === undefined ? due : Math.min(retryAt, due);
      } else {
        actions.push({ kind: "answerBrief", taskId: task.id });
      }
    }
  }
  return { actions, retryAt };
}

/**
 * The answers, moved into the brief and the question cleared — what the extension's
 * own submit does, and kept in the brief on the live path too, because a later
 * subtask runs in a fresh session and would otherwise ask the same thing again.
 *
 * Returns the task to save and the question it delivered, or `undefined` when the
 * request is no longer there to claim.
 */
export function claimAnswers(
  task: TaskWorkspace | undefined,
  at: string,
  callId?: string,
): { task: TaskWorkspace; question: PendingQuestion } | undefined {
  const pipeline = task?.pipeline;
  const question = pipeline?.pendingQuestion;
  if (!task || !pipeline || !question || !submitted(question)) return undefined;
  if (unansweredQuestions(pipeline).length > 0) return undefined;
  // A different question has replaced the one this window meant to deliver.
  if (callId !== undefined && question.liveCallId !== callId) return undefined;

  return {
    task: {
      ...task,
      description: [task.description, answersTranscript(question)].filter(Boolean).join("\n\n"),
      pipeline: clearQuestion(pipeline),
      updatedAt: at,
    },
    question,
  };
}

/** Each question paired with its answer, as the brief records them. */
export function answersTranscript(question: PendingQuestion): string {
  return question.items
    .map((item) => `Q: ${item.text}\nA: ${item.answer?.trim() ?? ""}`)
    .join("\n\n");
}

function submitted(question: PendingQuestion): boolean {
  return typeof question.submittedAt === "string" && question.submittedAt.length > 0;
}
