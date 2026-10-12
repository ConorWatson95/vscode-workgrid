import { describe, expect, it } from "vitest";
import { summariseRun } from "./harnessSnapshot";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { TaskWorkspace } from "../domain/taskWorkspace";

function stage(overrides: Partial<TaskStage>): TaskStage {
  return {
    id: "s",
    name: "Stage",
    kind: "implementation",
    status: "pending",
    intent: "do it",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...overrides,
  };
}

function task(stages: TaskStage[], extra: Partial<TaskPipeline> = {}): TaskWorkspace {
  return {
    id: "t1",
    name: "Pyramid export",
    repositoryRoot: "C:/repo",
    worktreePath: "C:/repo-worktrees/t1",
    branchName: "feat/pyramid",
    baseBranch: "DEV",
    status: "ready",
    createdAt: "2026-10-08T09:00:00.000Z",
    updatedAt: "2026-10-08T09:00:00.000Z",
    pipeline: { routeId: "r", stages, ...extra },
  } as TaskWorkspace;
}

const done = (id: string) => stage({ id, name: id, status: "passed" });

describe("summariseRun attention", () => {
  it("asks for the answer first, from when the question was asked", () => {
    const run = summariseRun(
      task([done("a"), stage({ id: "plan", name: "Plan", status: "active" })], {
        pendingQuestion: {
          stageId: "plan",
          stageName: "Plan",
          subtaskId: "x",
          askedAt: "2026-10-08T10:00:00.000Z",
          items: [{ id: "q1", text: "Which tab?" }, { id: "q2", text: "Which dealer?" }],
        },
      } as Partial<TaskPipeline>),
    );
    expect(run.group).toBe("needs-you");
    expect(run.attention).toMatchObject({
      need: "Answer 2 questions from “Plan”",
      since: "2026-10-08T10:00:00.000Z",
      tone: "ask",
      stageId: "plan",
    });
  });

  it("names a failed stage, timed from the subtask that failed", () => {
    const run = summariseRun(
      task([
        done("a"),
        stage({
          id: "build",
          name: "Build",
          status: "failed",
          subtasks: [{ id: "b1", title: "b", prompt: "p", status: "failed", finishedAt: "2026-10-08T11:00:00.000Z" }],
        }),
      ]),
    );
    expect(run.attention).toMatchObject({ need: "“Build” failed — retry or fix", tone: "fail", since: "2026-10-08T11:00:00.000Z" });
    expect(run.strip).toEqual(["done", "failed"]);
  });

  it("counts a gate's outstanding items in the line that asks for it", () => {
    const run = summariseRun(
      task([
        done("a"),
        stage({
          id: "verify",
          name: "Verify locally",
          kind: "humanVerification",
          status: "awaiting-approval",
          requiresApproval: true,
          finishedAt: "2026-10-08T12:00:00.000Z",
          checklist: [
            { id: "c1", text: "totals match", checked: false, raisedByStage: "verify" },
            { id: "c2", text: "export opens", checked: false, raisedByStage: "verify" },
          ],
        }),
      ]),
    );
    expect(run.attention).toMatchObject({ need: "Verify “Verify locally” · 2 items", since: "2026-10-08T12:00:00.000Z" });
    expect(run.progress).toEqual({ done: 1, total: 2 });
  });

  it("says what a working run is doing, and asks nothing of anybody", () => {
    const run = summariseRun(
      task([
        done("a"),
        stage({
          id: "impl",
          name: "Implement",
          status: "active",
          startedAt: "2026-10-08T08:00:00.000Z",
          subtasks: [{ id: "i1", title: "i", prompt: "p", status: "active", startedAt: "2026-10-08T13:00:00.000Z" }],
        }),
      ]),
    );
    expect(run.group).toBe("working");
    expect(run.attention.need).toBeUndefined();
    expect(run.attention).toMatchObject({ tone: "run", since: "2026-10-08T13:00:00.000Z", stageId: "impl" });
  });

  it("calls a run with every stage resolved done", () => {
    const run = summariseRun(task([done("a"), done("b")]));
    expect(run.attention).toEqual({ status: "All stages resolved", tone: "done" });
  });
});
