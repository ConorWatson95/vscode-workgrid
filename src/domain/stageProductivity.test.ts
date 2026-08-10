import { describe, expect, it } from "vitest";
import { changedNothing } from "./stageProductivity";
import { Subtask, TaskStage } from "./taskPipeline";

const subtask = (overrides: Partial<Subtask> = {}): Subtask => ({
  id: "s1",
  title: "Fix it",
  prompt: "p",
  status: "done",
  startedAt: "t1",
  finishedAt: "t2",
  ...overrides,
});

const stage = (overrides: Partial<TaskStage> = {}): TaskStage => ({
  id: "implement",
  name: "Implement",
  kind: "implementation",
  status: "passed",
  intent: "Fix the defect.",
  splittable: false,
  requiresApproval: false,
  subtasks: [subtask()],
  ...overrides,
});

/**
 * The check that needs no cooperation from the reply.
 *
 * Every other defence depends on the stage saying it did not do its work. Each closed a
 * real hole and each has the same weakness: a stage that declines in prose passes. The
 * case that prompted this produced an excellent root-cause analysis, concluded the fix
 * was out of scope, wrote "Why I stopped", and the route advanced onto stages assuming a
 * fix that did not exist.
 */
describe("an implementation stage that changed nothing", () => {
  it("is caught when no subtask wrote a file", () => {
    expect(
      changedNothing(stage({ subtasks: [subtask({ activity: { toolCounts: { Read: 9 } } })] })),
    ).toBe(true);
  });

  it("says nothing when no activity was recorded at all", () => {
    // Absence of a measurement is not evidence of zero. A subtask that ran before
    // activity was recorded, or whose watcher produced nothing, tells us nothing about
    // what it wrote — and holding a stage on a missing measurement is the same error as
    // reporting a cost of zero for a session that reported none.
    expect(changedNothing(stage())).toBe(false);
  });

  it("is not caught when something was written", () => {
    expect(
      changedNothing(
        stage({ subtasks: [subtask({ activity: { pathsWritten: ["src/a.ts"] } })] }),
      ),
    ).toBe(false);
  });

  it("counts writes from any subtask of a split stage", () => {
    // One unit investigating and another editing is a normal split, not a stage that
    // did nothing.
    expect(
      changedNothing(
        stage({
          subtasks: [
            subtask({ id: "s1" }),
            subtask({ id: "s2", activity: { pathsWritten: ["src/b.ts"] } }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("leaves every other kind of stage alone", () => {
    // A review, a deployment and an assessment all legitimately write nothing, and a
    // check that fires constantly is one people approve through without reading.
    for (const kind of ["codeReview", "domainReview", "deployment", "assessment", "behaviourReview"] as const) {
      expect(changedNothing(stage({ kind }))).toBe(false);
    }
  });

  it("says nothing about a stage that never ran", () => {
    expect(
      changedNothing(stage({ status: "pending", subtasks: [subtask({ status: "pending", startedAt: undefined })] })),
    ).toBe(false);
  });

  it("defers to a declared check that passed", () => {
    // The whole reason this exists is a stage backed by nothing but its own account.
    // Where something other than the agent certified the work, an unusual way of making
    // the change is not the harness's business.
    expect(
      changedNothing(
        stage({
          subtasks: [subtask({ activity: { toolCounts: { Read: 3 } } })],
          verification: { command: "dotnet build", exitCode: 0, at: "t" },
        }),
      ),
    ).toBe(false);
  });

  it("still holds when the declared check failed", () => {
    expect(
      changedNothing(
        stage({
          subtasks: [subtask({ activity: { toolCounts: { Read: 3 } } })],
          verification: { command: "dotnet build", exitCode: 1, at: "t" },
        }),
      ),
    ).toBe(true);
  });

  it("counts running a command as not having written", () => {
    // The case worth stopping on is exactly this: read-only investigation, reported as
    // completed work.
    expect(
      changedNothing(
        stage({ subtasks: [subtask({ activity: { commands: ["sqlcmd -Q \"select 1\""] } })] }),
      ),
    ).toBe(true);
  });
});
