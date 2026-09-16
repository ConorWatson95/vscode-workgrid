import { describe, expect, it } from "vitest";
import { briefFault, fatigueAdvice, repairFatigue } from "./correctionBrief";
import { Subtask, TaskStage } from "./taskPipeline";

function subtask(over: Partial<Subtask> = {}): Subtask {
  return {
    id: `s${Math.random()}`,
    title: "unit",
    prompt: "",
    status: "done",
    ...over,
  };
}

function repair(over: Partial<Subtask> = {}, upstream = false): Subtask {
  return subtask({
    correction: upstream
      ? { finding: "brought into line", at: "2026-09-15T00:00:00Z", upstream: { stageId: "u", stageName: "Implement the data" } }
      : { finding: "the total double-counts", at: "2026-09-15T00:00:00Z" },
    ...over,
  });
}

function stage(subtasks: Subtask[]): TaskStage {
  return {
    id: "rc-implement-app",
    name: "Implement the application",
    kind: "implementation",
    status: "active",
    subtasks,
  } as TaskStage;
}

describe("briefFault", () => {
  it("refuses the finding that caused this — a bare verdict", () => {
    expect(briefFault("Incorrect.")).toMatch(/not what is wrong/);
    expect(briefFault("still wrong")).toMatch(/not what is wrong/);
    expect(briefFault("no, fix it again")).toMatch(/not what is wrong/);
  });

  it("refuses a finding too short to name a subject and a behaviour", () => {
    expect(briefFault("bad totals")).toMatch(/whole brief/);
  });

  it("accepts a short real finding", () => {
    expect(briefFault("tabs still hidden")).toBeUndefined();
    expect(briefFault("Tabs should not be hidden when Detail is selected")).toBeUndefined();
  });

  it("does not refuse a finding merely because it contains a verdict word", () => {
    expect(briefFault("no total column on the export")).toBeUndefined();
    expect(briefFault("the period filter is wrong on Category")).toBeUndefined();
  });

  it("still refuses an empty box", () => {
    expect(briefFault("   ")).toMatch(/Say what is wrong/);
  });
});

describe("repairFatigue", () => {
  it("says nothing about a stage nobody has corrected", () => {
    expect(repairFatigue(stage([subtask(), subtask(), subtask(), subtask(), subtask()]))).toBeUndefined();
  });

  it("says nothing below the threshold", () => {
    expect(repairFatigue(stage([subtask(), repair(), repair(), repair()]))).toBeUndefined();
  });

  it("separates corrections from amendments", () => {
    const fatigue = repairFatigue(
      stage([subtask(), repair(), repair(), repair({}, true), repair({}, true)]),
    );
    expect(fatigue).toMatchObject({ repairs: 4, corrections: 2, amendments: 2 });
  });

  it("counts a repair that wrote no file, and leaves an unmeasured one out", () => {
    const fatigue = repairFatigue(
      stage([
        repair({ activity: { toolCounts: {}, pathsWritten: [] } as never }),
        repair({ activity: { toolCounts: {}, pathsWritten: ["a.cs"] } as never }),
        repair(),
        repair(),
      ]),
    );
    expect(fatigue?.barren).toBe(1);
  });
});

describe("fatigueAdvice", () => {
  it("names the alternative, not just the count", () => {
    const advice = fatigueAdvice(stage([repair(), repair(), repair({}, true), repair({}, true)]));
    expect(advice).toContain("repaired 4 times");
    expect(advice).toMatch(/re-run/);
  });

  it("is silent below the threshold", () => {
    expect(fatigueAdvice(stage([repair()]))).toBeUndefined();
  });
});
