import { describe, expect, it } from "vitest";
import { describeStaleSubtask, staleActiveSubtasks } from "./staleSubtask";
import { SubtaskStatus, TaskPipeline, TaskStage } from "./taskPipeline";

const NOW = "2026-08-12T11:00:00.000Z";
const HOUR = 60 * 60 * 1000;

function stage(
  id: string,
  subtasks: Array<{ id: string; status: SubtaskStatus; startedAt?: string }>,
): TaskStage {
  return {
    id,
    name: id,
    kind: "implement",
    status: "active",
    intent: "Do the work.",
    splittable: false,
    requiresApproval: false,
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.id,
      prompt: "Do the work.",
      status: s.status,
      startedAt: s.startedAt,
    })),
  } as TaskStage;
}

const pipeline = (stages: TaskStage[]): TaskPipeline => ({
  routeId: "report-change",
  stages,
});

const none = () => false;

describe("staleActiveSubtasks", () => {
  it("reports an active subtask older than the threshold that nothing owns", () => {
    const stale = staleActiveSubtasks(
      pipeline([
        stage("implement-app", [
          { id: "implement-app-1", status: "active", startedAt: "2026-08-12T09:08:36.485Z" },
        ]),
      ]),
      { now: NOW, thresholdMs: HOUR, owned: none },
    );

    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      stageId: "implement-app",
      subtaskId: "implement-app-1",
      startedAt: "2026-08-12T09:08:36.485Z",
    });
    expect(stale[0].ageMs).toBeGreaterThan(HOUR);
  });

  it("leaves a subtask this host started alone, however old", () => {
    const stale = staleActiveSubtasks(
      pipeline([
        stage("implement-app", [
          { id: "implement-app-1", status: "active", startedAt: "2026-08-01T00:00:00.000Z" },
        ]),
      ]),
      { now: NOW, thresholdMs: HOUR, owned: (id) => id === "implement-app-1" },
    );

    expect(stale).toEqual([]);
  });

  // The state file is shared by every worktree of a repository, so an active
  // subtask this host has never heard of may belong to another window that
  // started it seconds ago.
  it("leaves a young unowned subtask alone", () => {
    const stale = staleActiveSubtasks(
      pipeline([
        stage("implement-app", [
          { id: "implement-app-1", status: "active", startedAt: "2026-08-12T10:55:00.000Z" },
        ]),
      ]),
      { now: NOW, thresholdMs: HOUR, owned: none },
    );

    expect(stale).toEqual([]);
  });

  it("ignores subtasks that are not active", () => {
    const stale = staleActiveSubtasks(
      pipeline([
        stage("implement-app", [
          { id: "done", status: "done", startedAt: "2026-08-01T00:00:00.000Z" },
          { id: "failed", status: "failed", startedAt: "2026-08-01T00:00:00.000Z" },
          { id: "pending", status: "pending" },
          { id: "skipped", status: "skipped", startedAt: "2026-08-01T00:00:00.000Z" },
        ]),
      ]),
      { now: NOW, thresholdMs: HOUR, owned: none },
    );

    expect(stale).toEqual([]);
  });

  // `startSubtask` always records a start, so absence is a corrupt record — and
  // the recoverable reading is the one that unwedges the task.
  it("treats an active subtask with no start time as stale", () => {
    const stale = staleActiveSubtasks(
      pipeline([stage("implement-app", [{ id: "implement-app-1", status: "active" }])]),
      { now: NOW, thresholdMs: HOUR, owned: none },
    );

    expect(stale).toHaveLength(1);
    expect(stale[0].ageMs).toBeUndefined();
    expect(stale[0].startedAt).toBeUndefined();
  });

  it("treats an unparseable start time as stale rather than skipping it", () => {
    const stale = staleActiveSubtasks(
      pipeline([
        stage("implement-app", [
          { id: "implement-app-1", status: "active", startedAt: "not a date" },
        ]),
      ]),
      { now: NOW, thresholdMs: HOUR, owned: none },
    );

    expect(stale).toHaveLength(1);
    expect(stale[0].ageMs).toBeUndefined();
  });

  it("finds them across every stage", () => {
    const old = "2026-08-12T08:00:00.000Z";
    const stale = staleActiveSubtasks(
      pipeline([
        stage("a", [{ id: "a-1", status: "active", startedAt: old }]),
        stage("b", [
          { id: "b-1", status: "done", startedAt: old },
          { id: "b-2", status: "active", startedAt: old },
        ]),
      ]),
      { now: NOW, thresholdMs: HOUR, owned: none },
    );

    expect(stale.map((s) => s.subtaskId)).toEqual(["a-1", "b-2"]);
  });

  it("reports nothing for a task with no pipeline", () => {
    expect(staleActiveSubtasks(undefined, { now: NOW, thresholdMs: HOUR, owned: none })).toEqual(
      [],
    );
  });
});

describe("describeStaleSubtask", () => {
  it("gives the age in minutes", () => {
    expect(
      describeStaleSubtask({
        stageId: "implement-app",
        stageName: "Implement the application",
        subtaskId: "implement-app-1",
        subtaskTitle: "Implement the application",
        ageMs: 147 * 60 * 1000,
      }),
    ).toContain("active for 147 minute(s)");
  });

  it("says so when there is no start to measure from", () => {
    expect(
      describeStaleSubtask({
        stageId: "s",
        stageName: "Stage",
        subtaskId: "s-1",
        subtaskTitle: "Subtask",
      }),
    ).toContain("no recorded start");
  });
});
