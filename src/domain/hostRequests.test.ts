import { describe, expect, it } from "vitest";
import { decideAnswers } from "./harnessControl";
import { LIVE_GRACE_MS, claimAnswers, hostWork } from "./hostRequests";
import { PendingQuestion, TaskPipeline, TaskStage, normalizePipeline } from "./taskPipeline";
import { TaskWorkspace } from "./taskWorkspace";

const AT = "2026-10-09T10:00:00.000Z";
const NOW = Date.parse(AT);

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "impl",
    name: "Implement",
    kind: "implementation",
    status: "active",
    intent: "do it",
    splittable: false,
    requiresApproval: false,
    subtasks: [{ id: "impl-1", title: "do it", prompt: "do it", status: "pending" }],
    ...overrides,
  };
}

function question(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    stageId: "impl",
    stageName: "Implement",
    subtaskId: "impl-1",
    askedAt: "2026-10-09T09:00:00.000Z",
    items: [
      { id: "impl-1-q1", text: "Which tab?" },
      { id: "impl-1-q2", text: "Monthly or weekly?" },
    ],
    ...overrides,
  };
}

function task(pipeline: Partial<TaskPipeline> = {}, id = "t1"): TaskWorkspace {
  return {
    id,
    name: "Task " + id,
    repositoryRoot: "C:/repo",
    worktreePath: "C:/w/" + id,
    branchName: "feat/" + id,
    baseBranch: "main",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    description: "The brief.",
    pipeline: { routeId: "r", stages: [stage()], ...pipeline },
  };
}

/** The asking subtask still running, which is what holds a live call open. */
const running = [stage({ subtasks: [{ id: "impl-1", title: "x", prompt: "x", status: "active" }] })];

const answered = (overrides: Partial<PendingQuestion> = {}) =>
  question({
    items: [
      { id: "impl-1-q1", text: "Which tab?", answer: "tab 3" },
      { id: "impl-1-q2", text: "Monthly or weekly?", answer: "monthly" },
    ],
    submittedAt: AT,
    ...overrides,
  });

describe("decideAnswers", () => {
  it("puts a NEEDS-INFO question's answers straight into the brief", () => {
    const t = task({ pendingQuestion: question() });
    const outcome = decideAnswers(t, {
      askedAt: question().askedAt,
      answers: { "impl-1-q1": "tab 3", "impl-1-q2": " monthly " },
      at: AT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.task.pipeline!.pendingQuestion).toBeUndefined();
    expect(outcome.value.task.description).toContain("A: monthly");
    expect(outcome.value.readyToAdvance).toBe(true);
  });

  it("records a live question's answers for the session's owner to deliver", () => {
    const t = task({ stages: running, pendingQuestion: question({ liveCallId: "call-1" }) });
    const outcome = decideAnswers(t, {
      askedAt: question().askedAt,
      answers: { "impl-1-q1": "tab 3", "impl-1-q2": " monthly " },
      at: AT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const pending = outcome.value.task.pipeline!.pendingQuestion!;
    expect(pending.items.map((i) => i.answer)).toEqual(["tab 3", "monthly"]);
    expect(pending.submittedAt).toBe(AT);
  });

  it("puts the answers in the brief when the session that asked has stopped", () => {
    // The parked task: a headless run asked, died and was reclaimed, and the answer
    // given afterwards waited for a call no process held any more.
    const t = task({ pendingQuestion: question({ liveCallId: "call-1" }) });
    const outcome = decideAnswers(t, {
      askedAt: question().askedAt,
      answers: { "impl-1-q1": "tab 3", "impl-1-q2": "monthly" },
      at: AT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.readyToAdvance).toBe(true);
    expect(outcome.value.task.pipeline!.pendingQuestion).toBeUndefined();
    expect(outcome.value.task.description).toContain("A: tab 3");
  });

  it("is allowed while the asking session runs, since a live question is asked by one", () => {
    const t = task({
      stages: [stage({ subtasks: [{ id: "impl-1", title: "x", prompt: "x", status: "active" }] })],
      pendingQuestion: question({ liveCallId: "call-1" }),
    });
    const outcome = decideAnswers(t, {
      askedAt: question().askedAt,
      answers: { "impl-1-q1": "a", "impl-1-q2": "b" },
      at: AT,
    });
    expect(outcome.ok).toBe(true);
  });

  it("refuses answers to a question that has since been replaced", () => {
    const t = task({ pendingQuestion: question({ askedAt: "2026-10-09T09:30:00.000Z" }) });
    const outcome = decideAnswers(t, {
      askedAt: question().askedAt,
      answers: { "impl-1-q1": "a", "impl-1-q2": "b" },
      at: AT,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("stale");
  });

  it("refuses a partial set, since the stage needs every answer", () => {
    const t = task({ pendingQuestion: question() });
    const outcome = decideAnswers(t, { askedAt: question().askedAt, answers: { "impl-1-q1": "a" }, at: AT });
    expect(outcome.ok).toBe(false);
  });
});

describe("hostWork", () => {
  it("delivers a live answer only in the window that owns the call", () => {
    const tasks = [task({ stages: running, pendingQuestion: answered({ liveCallId: "call-1" }) })];
    expect(hostWork(tasks, NOW, (id) => id === "call-1").actions).toEqual([
      { kind: "answerLive", taskId: "t1", callId: "call-1" },
    ]);

    // Another window waits for the owner, and says when to look again.
    const elsewhere = hostWork(tasks, NOW, () => false);
    expect(elsewhere.actions).toEqual([]);
    expect(elsewhere.retryAt).toBe(NOW + LIVE_GRACE_MS);

    // Unclaimed after the grace period, nobody owns it: into the brief.
    expect(hostWork(tasks, NOW + LIVE_GRACE_MS, () => false).actions).toEqual([
      { kind: "answerBrief", taskId: "t1" },
    ]);
  });

  it("delivers an answer for a stopped session into the brief without waiting", () => {
    const tasks = [task({ pendingQuestion: answered({ liveCallId: "call-1" }) })];
    expect(hostWork(tasks, NOW, () => false).actions).toEqual([{ kind: "answerBrief", taskId: "t1" }]);
  });

  it("delivers a NEEDS-INFO answer anywhere, and ignores questions nobody submitted", () => {
    const tasks = [
      task({ pendingQuestion: answered() }, "t1"),
      task({ pendingQuestion: question() }, "t2"),
    ];
    expect(hostWork(tasks, NOW, () => false).actions).toEqual([{ kind: "answerBrief", taskId: "t1" }]);
  });

});

describe("claims", () => {
  it("moves the answers into the brief and clears the question, once", () => {
    const claimed = claimAnswers(task({ pendingQuestion: answered() }), AT);
    expect(claimed?.task.description).toBe("The brief.\n\nQ: Which tab?\nA: tab 3\n\nQ: Monthly or weekly?\nA: monthly");
    expect(claimed?.task.pipeline?.pendingQuestion).toBeUndefined();
    // The second window reads the first one's write and finds nothing to claim.
    expect(claimAnswers(claimed!.task, AT)).toBeUndefined();
  });

  it("will not deliver a live call's answers to a question that replaced it", () => {
    const t = task({ pendingQuestion: answered({ liveCallId: "call-2" }) });
    expect(claimAnswers(t, AT, "call-1")).toBeUndefined();
  });

  it("a submitted question and a run lease survive a reload of the state file", () => {
    const lease = { by: "headless", pid: 4, host: "h", processStartedAt: AT, acquiredAt: AT };
    const stored = JSON.parse(JSON.stringify({ routeId: "r", stages: [stage()], runLease: lease, pendingQuestion: answered() }));
    const loaded = normalizePipeline(stored);
    expect(loaded?.runLease).toEqual(lease);
    expect(loaded?.pendingQuestion?.submittedAt).toBe(AT);
  });
});
