import { describe, expect, it } from "vitest";
import { checkAuthoringSkipped } from "./checkAuthoring";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

function item(over: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return { text: "something to look at", checked: false, raisedByStage: "gate", ...over };
}

function gate(over: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "gate",
    name: "gate",
    kind: "humanVerification",
    status: "awaiting-approval",
    intent: "",
    gate: "approval",
    subtasks: [],
    checkManifest: "checks.json",
    checklist: [item({ id: "1" })],
    ...over,
  } as TaskStage;
}

function pipeline(stage: TaskStage): TaskPipeline {
  return { routeId: "r", stages: [stage], currentStageId: stage.id } as TaskPipeline;
}

const unchanged = { before: "{}", after: "{}" };

describe("checkAuthoringSkipped", () => {
  it("holds a gate that left an item untagged and never touched the manifest", () => {
    expect(checkAuthoringSkipped(pipeline(gate()), "gate", unchanged)).toMatch(/no check/i);
  });

  it("says nothing where the route declared no manifest", () => {
    const stage = gate();
    delete (stage as { checkManifest?: string }).checkManifest;
    expect(checkAuthoringSkipped(pipeline(stage), "gate", unchanged)).toBeUndefined();
  });

  it("says nothing when the manifest changed", () => {
    const sample = { before: "{}", after: '{"checks":[]}' };
    expect(checkAuthoringSkipped(pipeline(gate()), "gate", sample)).toBeUndefined();
  });

  it("says nothing when the manifest appeared during the session", () => {
    const sample = { before: undefined, after: "{}" };
    expect(checkAuthoringSkipped(pipeline(gate()), "gate", sample)).toBeUndefined();
  });

  it("says nothing when the manifest is unreadable both ways", () => {
    // A path nobody typed correctly reads exactly like one the stage should have
    // created, and holding on it would hold every gate of every route forever.
    const sample = { before: undefined, after: undefined };
    expect(checkAuthoringSkipped(pipeline(gate()), "gate", sample)).toBeUndefined();
  });

  it("says nothing when every item names a check", () => {
    const stage = gate({ checklist: [item({ id: "1", coveredBy: "a" })] });
    expect(checkAuthoringSkipped(pipeline(stage), "gate", unchanged)).toBeUndefined();
  });

  it("says nothing about a gap a person already answered", () => {
    const stage = gate({ checklist: [item({ id: "1", checked: true })] });
    expect(checkAuthoringSkipped(pipeline(stage), "gate", unchanged)).toBeUndefined();
  });

  it("holds when one of several items is untagged", () => {
    const stage = gate({
      checklist: [item({ id: "1", coveredBy: "a" }), item({ id: "2" })],
    });
    expect(checkAuthoringSkipped(pipeline(stage), "gate", unchanged)).toBeDefined();
  });
});
