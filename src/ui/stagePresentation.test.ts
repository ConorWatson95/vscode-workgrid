import { describe, it, expect } from "vitest";
import {
  checklistPresentation,
  pipelineSummary,
  stagePresentation,
} from "./stagePresentation";
import { ChecklistItem, TaskStage } from "../domain/taskPipeline";
import { createPipeline, planStage, recordChecklist } from "../domain/pipelineEngine";
import { findRoute } from "../domain/taskRoute";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "fix",
    name: "Fix",
    kind: "implementation",
    status: "pending",
    intent: "Fix it.",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...overrides,
  };
}

function subtask(id: string, status: TaskStage["subtasks"][number]["status"]) {
  return { id, title: id, prompt: "p", status };
}

function item(id: string, checked: boolean): ChecklistItem {
  return { id, text: `check ${id}`, checked, raisedByStage: "fix" };
}

describe("stagePresentation", () => {
  it("distinguishes every stage status by icon", () => {
    const icons = (["pending", "active", "awaiting-approval", "passed", "failed", "skipped"] as const).map(
      (status) => stagePresentation(stage({ status })).iconId,
    );
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("spins only while a stage is active", () => {
    expect(stagePresentation(stage({ status: "active" })).iconId).toContain("~spin");
    expect(stagePresentation(stage({ status: "pending" })).iconId).not.toContain("~spin");
  });

  it("flags a splittable stage that has not been planned yet", () => {
    const visual = stagePresentation(stage({ splittable: true, subtasks: [] }));
    expect(visual.description).toBe("needs planning");
    expect(visual.iconId).toBe("list-tree");
  });

  it("counts subtask progress once there is more than one", () => {
    const visual = stagePresentation(
      stage({
        status: "active",
        subtasks: [subtask("a", "done"), subtask("b", "active"), subtask("c", "pending")],
      }),
    );
    expect(visual.description).toBe("1/3");
  });

  it("omits a count for a single-unit stage, where 0/1 is noise", () => {
    expect(stagePresentation(stage({ subtasks: [subtask("a", "pending")] })).description).toBe("");
  });

  it("surfaces outstanding verification items", () => {
    const visual = stagePresentation(
      stage({ status: "awaiting-approval", checklist: [item("c1", false), item("c2", true)] }),
    );
    expect(visual.description).toContain("awaiting approval");
    expect(visual.description).toContain("1 to verify");
  });

  it("shows the failure reason rather than just 'failed'", () => {
    const visual = stagePresentation(
      stage({
        status: "failed",
        subtasks: [{ ...subtask("a", "failed"), failureReason: "suite red" }],
      }),
    );
    expect(visual.description).toBe("suite red");
  });

  it("falls back to 'failed' when no reason was recorded", () => {
    expect(
      stagePresentation(stage({ status: "failed", subtasks: [subtask("a", "failed")] })).description,
    ).toBe("failed");
  });

  it("says nothing extra for a passed stage", () => {
    expect(stagePresentation(stage({ status: "passed" })).description).toBe("");
  });

  it("gives each status a distinct context value for menu targeting", () => {
    expect(stagePresentation(stage({ status: "awaiting-approval" })).contextValue).toBe(
      "stage-awaiting-approval",
    );
    expect(stagePresentation(stage({ status: "failed" })).contextValue).toBe("stage-failed");
  });
});

describe("checklistPresentation", () => {
  it("marks checked and unchecked items differently", () => {
    expect(checklistPresentation(item("a", true)).contextValue).toBe("checklist-checked");
    expect(checklistPresentation(item("a", false)).contextValue).toBe("checklist-unchecked");
    expect(checklistPresentation(item("a", true)).iconId).not.toBe(
      checklistPresentation(item("a", false)).iconId,
    );
  });
});

describe("pipelineSummary", () => {
  it("returns nothing for an unharnessed task", () => {
    expect(pipelineSummary(undefined)).toBeUndefined();
    expect(pipelineSummary({ routeId: "x", stages: [] })).toBeUndefined();
  });

  it("summarises route, stage progress and outstanding verification", () => {
    const route = findRoute("bug-fix")!;
    let pipeline = createPipeline(route);
    pipeline = { ...pipeline, stages: pipeline.stages.map((s, i) => (i === 0 ? { ...s, status: "passed" } : s)) };
    const planned = planStage(pipeline, "fix", [{ title: "a", prompt: "a" }]);
    if (planned.ok) pipeline = planned.value;
    const withItems = recordChecklist(pipeline, "code-review", ["one", "two"]);
    if (withItems.ok) pipeline = withItems.value;

    const summary = pipelineSummary(pipeline, route.label);
    expect(summary).toBe("Bug fix · 1/5 · 2 to verify");
  });

  it("falls back to the route id when no label is supplied", () => {
    expect(pipelineSummary({ routeId: "ad-hoc", stages: [stage()] })).toBe("ad-hoc · 0/1");
  });

  it("ignores items belonging to a skipped stage", () => {
    const summary = pipelineSummary({
      routeId: "r",
      stages: [stage({ status: "skipped", checklist: [item("c1", false)] })],
    });
    expect(summary).toBe("r · 1/1");
  });
});
