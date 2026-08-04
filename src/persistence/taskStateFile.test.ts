import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "./storedStateMigration";
import {
  decodeTaskStateFile,
  encodeTaskStateFile,
  taskStateFilePath,
} from "./taskStateFile";
import { TaskWorkspace } from "../domain/taskWorkspace";

const task: TaskWorkspace = {
  id: "t1",
  name: "Task one",
  repositoryRoot: "C:/repo",
  worktreePath: "C:/repo-worktrees/t1",
  branchName: "feat/one",
  baseBranch: "main",
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("taskStateFilePath", () => {
  it("puts state under the git dir, where git will not see it as a change", () => {
    const p = taskStateFilePath("/repo/.git").replace(/\\/g, "/");
    expect(p).toBe("/repo/.git/task-workspaces/state.json");
  });

  it("honours a separated git dir rather than assuming a .git child", () => {
    const p = taskStateFilePath("/elsewhere/gitdirs/repo").replace(/\\/g, "/");
    expect(p).toBe("/elsewhere/gitdirs/repo/task-workspaces/state.json");
  });
});

describe("decodeTaskStateFile", () => {
  it("reads an absent file as no tasks, not an error", () => {
    const outcome = decodeTaskStateFile(undefined);
    expect(outcome.tasks).toEqual([]);
    expect(outcome.quarantined).toEqual([]);
  });

  it("reads an empty file as no tasks without quarantining a blank blob", () => {
    const outcome = decodeTaskStateFile("   \n");
    expect(outcome.tasks).toEqual([]);
    expect(outcome.quarantined).toEqual([]);
    expect(outcome.notes.join(" ")).toContain("empty");
  });

  it("round-trips through encode", () => {
    const outcome = decodeTaskStateFile(encodeTaskStateFile([task]));
    expect(outcome.tasks).toEqual([task]);
    expect(outcome.sourceVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("keeps invalid JSON verbatim instead of discarding it", () => {
    const outcome = decodeTaskStateFile("{ tasks: [ truncated");
    expect(outcome.tasks).toEqual([]);
    expect(outcome.quarantined).toEqual(["{ tasks: [ truncated"]);
  });

  it("reads a bare array written before the versioned envelope", () => {
    const outcome = decodeTaskStateFile(JSON.stringify([task]));
    expect(outcome.tasks).toEqual([task]);
    expect(outcome.sourceVersion).toBe(0);
  });

  it("reads state from a newer version rather than refusing it", () => {
    const text = JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION + 5,
      tasks: [task],
    });
    const outcome = decodeTaskStateFile(text);
    expect(outcome.tasks).toEqual([task]);
    expect(outcome.fromNewerVersion).toBe(true);
  });
});

describe("encodeTaskStateFile", () => {
  it("writes the current schema version", () => {
    const parsed = JSON.parse(encodeTaskStateFile([task]));
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("ends with a newline so the file behaves in a terminal", () => {
    expect(encodeTaskStateFile([task]).endsWith("\n")).toBe(true);
  });
});
