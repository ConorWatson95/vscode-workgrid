import { describe, expect, it } from "vitest";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { planLegacyAdoption } from "./legacyStateAdoption";

function task(id: string, repositoryRoot: string): TaskWorkspace {
  return {
    id,
    name: id,
    repositoryRoot,
    worktreePath: `${repositoryRoot}-worktrees/${id}`,
    branchName: `feat/${id}`,
    baseBranch: "main",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("planLegacyAdoption", () => {
  it("takes only the tasks belonging to this repository", () => {
    const plan = planLegacyAdoption({
      stateFileExists: false,
      legacyTasks: [task("mine", "C:/repo"), task("theirs", "C:/other")],
      repositoryRoot: "C:/repo",
    });

    expect(plan?.seed.map((t) => t.id)).toEqual(["mine"]);
  });

  it("matches roots case- and separator-insensitively", () => {
    const plan = planLegacyAdoption({
      stateFileExists: false,
      legacyTasks: [task("mine", "C:\\Repo\\")],
      repositoryRoot: "c:/repo",
    });

    expect(plan?.seed).toHaveLength(1);
  });

  it("does nothing once a state file exists, so deleted tasks stay deleted", () => {
    const plan = planLegacyAdoption({
      stateFileExists: true,
      legacyTasks: [task("mine", "C:/repo")],
      repositoryRoot: "C:/repo",
    });

    expect(plan).toBeUndefined();
  });

  it("does nothing when the Memento holds nothing for this repository", () => {
    const plan = planLegacyAdoption({
      stateFileExists: false,
      legacyTasks: [task("theirs", "C:/other")],
      repositoryRoot: "C:/repo",
    });

    expect(plan).toBeUndefined();
  });

  it("reports what it adopted, so a silent hand-off is visible in the log", () => {
    const plan = planLegacyAdoption({
      stateFileExists: false,
      legacyTasks: [task("a", "C:/repo"), task("b", "C:/repo")],
      repositoryRoot: "C:/repo",
    });

    expect(plan?.note).toContain("2 task(s)");
    expect(plan?.note).toContain("backup");
  });
});
