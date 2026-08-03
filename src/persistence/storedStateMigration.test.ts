import { describe, it, expect } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  migrateStoredState,
} from "./storedStateMigration";
import { TaskWorkspace } from "../domain/taskWorkspace";

function task(overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id: "t1",
    name: "Fix mapping",
    repositoryRoot: "C:/repos/app",
    worktreePath: "C:/repos/app-t1",
    branchName: "fix/mapping",
    baseBranch: "main",
    status: "ready",
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("migrateStoredState", () => {
  it("returns nothing for absent state", () => {
    for (const empty of [undefined, null]) {
      const outcome = migrateStoredState(empty);
      expect(outcome.tasks).toEqual([]);
      expect(outcome.quarantined).toEqual([]);
    }
  });

  it("reads the current version unchanged", () => {
    const outcome = migrateStoredState({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tasks: [task()],
    });
    expect(outcome.tasks).toEqual([task()]);
    expect(outcome.quarantined).toEqual([]);
    expect(outcome.fromNewerVersion).toBe(false);
  });

  it("keeps tasks written by a newer version instead of discarding them", () => {
    // The regression this guards: a schema mismatch used to return [], which
    // would strand every worktree as an unadopted orphan.
    const outcome = migrateStoredState({
      schemaVersion: CURRENT_SCHEMA_VERSION + 5,
      tasks: [task()],
    });
    expect(outcome.tasks).toHaveLength(1);
    expect(outcome.fromNewerVersion).toBe(true);
    expect(outcome.notes.join(" ")).toContain("newer");
  });

  it("preserves fields it does not understand, so a downgrade loses nothing", () => {
    const withFuture = { ...task(), someFutureField: { nested: true } };
    const outcome = migrateStoredState({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      tasks: [withFuture],
    });
    expect(outcome.tasks[0]).toMatchObject({ someFutureField: { nested: true } });
  });

  it("accepts a bare array from before the versioned envelope", () => {
    const outcome = migrateStoredState([task()]);
    expect(outcome.tasks).toHaveLength(1);
    expect(outcome.sourceVersion).toBe(0);
  });

  it("quarantines a blob with no task array rather than dropping it", () => {
    const junk = { schemaVersion: 1, tasks: "not-an-array" };
    const outcome = migrateStoredState(junk);
    expect(outcome.tasks).toEqual([]);
    expect(outcome.quarantined).toEqual([junk]);
  });

  it("quarantines a non-object blob", () => {
    const outcome = migrateStoredState("corrupted");
    expect(outcome.quarantined).toEqual(["corrupted"]);
  });

  it("keeps good tasks and quarantines only the corrupt entries", () => {
    const outcome = migrateStoredState({
      schemaVersion: 1,
      tasks: [task({ id: "good" }), null, { id: "no-worktree" }, task({ id: "also-good" })],
    });
    expect(outcome.tasks.map((t) => t.id)).toEqual(["good", "also-good"]);
    expect(outcome.quarantined).toHaveLength(2);
  });

  it("rejects entries missing the fields reconciliation depends on", () => {
    const outcome = migrateStoredState({
      schemaVersion: 1,
      // worktreePath is how reconciliation matches git; repositoryRoot is how
      // tasks are scoped. Neither can be invented.
      tasks: [
        { id: "a", repositoryRoot: "C:/r" },
        { id: "b", worktreePath: "C:/w" },
        { worktreePath: "C:/w", repositoryRoot: "C:/r" },
      ],
    });
    expect(outcome.tasks).toEqual([]);
    expect(outcome.quarantined).toHaveLength(3);
  });

  it("backfills optional metadata missing from older records", () => {
    const outcome = migrateStoredState({
      tasks: [{ id: "t9", repositoryRoot: "C:/r", worktreePath: "C:/w" }],
    });
    expect(outcome.tasks[0]).toMatchObject({
      id: "t9",
      name: "t9", // falls back to the id rather than rendering blank
      branchName: "",
      status: "ready",
    });
  });

  it("replaces an unrecognised status with a safe default", () => {
    const outcome = migrateStoredState({
      tasks: [task({ status: "banana" as TaskWorkspace["status"] })],
    });
    expect(outcome.tasks[0].status).toBe("ready");
  });

  it("upgrades a legacy pipeline and drops an unreadable one", () => {
    const outcome = migrateStoredState({
      tasks: [
        task({ id: "a", pipeline: { stages: [{ name: "Implement", status: "active" }] } as never }),
        task({ id: "b", pipeline: { junk: true } as never }),
      ],
    });
    expect(outcome.tasks[0].pipeline).toMatchObject({
      routeId: "ad-hoc",
      stages: [{ id: "stage-1", name: "Implement", status: "active" }],
    });
    expect(outcome.tasks[1].pipeline).toBeUndefined();
  });

  it("leaves a task with no pipeline unharnessed rather than inventing one", () => {
    const outcome = migrateStoredState({ tasks: [task()] });
    expect("pipeline" in outcome.tasks[0]).toBe(false);
  });
});
