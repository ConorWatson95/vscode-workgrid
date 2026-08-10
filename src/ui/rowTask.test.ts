import { describe, expect, it } from "vitest";
import { isTask, rowTask } from "./rowTask";

const task = { id: "t1", name: "Phase 3", worktreePath: "/wt/phase-3" };

describe("rowTask", () => {
  it("reads the task off any row that carries one", () => {
    // The reported bug: "Show What This Did" reported "No task selected" from rows
    // that were pointing straight at a task. Only the task row and the stage row were
    // recognised, by class — these four were not.
    for (const row of [
      { task }, // task row
      { task, stage: { id: "sc-migration" } }, // stage row
      { task, stageId: "sc-migration", item: { id: "c1" } }, // checklist item
      { task, question: { id: "q1" } }, // question row
      { task, denial: { granted: false } }, // refusal row
      { task, call: { id: "h1" } }, // held call row
    ]) {
      expect(rowTask(row)).toBe(task);
    }
  });

  it("returns nothing for an invocation carrying no row at all", () => {
    // From the command palette there is no argument. The caller asks which task
    // rather than dead-ending, but that decision needs this to say "no task".
    expect(rowTask(undefined)).toBeUndefined();
    expect(rowTask(null)).toBeUndefined();
    expect(rowTask("t1")).toBeUndefined();
    expect(rowTask({})).toBeUndefined();
  });

  it("does not mistake another identified thing for a task", () => {
    // Every TreeItem this extension builds has an id, so id alone would let a row
    // whose `task` property held something else pass as a task.
    expect(rowTask({ task: { id: "not-a-task" } })).toBeUndefined();
    expect(isTask({ id: "x", worktreePath: 42 })).toBe(false);
  });
});
