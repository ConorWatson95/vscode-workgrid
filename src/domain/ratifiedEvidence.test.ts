import { describe, expect, it } from "vitest";
import { ratifiedEvidence, summariseRatified } from "./ratifiedEvidence";
import { TaskPipeline, TaskStage } from "./taskPipeline";

function stage(over: Partial<TaskStage> & { id: string }): TaskStage {
  return {
    id: over.id,
    name: over.name ?? over.id,
    kind: over.kind ?? "implementation",
    intent: "do it",
    status: over.status ?? "passed",
    subtasks: over.subtasks ?? [],
    requiresApproval: over.requiresApproval ?? false,
    ...over,
  } as TaskStage;
}

function pipeline(stages: TaskStage[]): TaskPipeline {
  return { routeId: "r", stages, guidance: [] } as unknown as TaskPipeline;
}

const verified = (id: string, over: Partial<TaskStage> = {}) =>
  stage({ id, verify: "build", verification: { command: "build", exitCode: 0, at: "t" }, ...over });

describe("ratifiedEvidence", () => {
  it("spans back to the previous approved gate, exclusive", () => {
    // The stage before the earlier gate was ratified at that gate. Presenting it again
    // trains the reader to skim a list they have already accepted.
    const p = pipeline([
      stage({ id: "old" }),
      stage({ id: "gate1", requiresApproval: true, status: "passed" }),
      stage({ id: "promote" }),
      stage({ id: "gate2", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    const span = ratifiedEvidence(p, "gate2").stages.map((entry) => entry.stage.id);
    expect(span).toEqual(["promote", "gate2"]);
  });

  it("does not let a skipped gate close a span", () => {
    // Nobody looked at a skipped gate, so the stages before it have still never been
    // accepted by a person -- the distinction `stageEvidence` keeps `assessed` for.
    const p = pipeline([
      stage({ id: "early" }),
      stage({ id: "skipped-gate", requiresApproval: true, status: "skipped" }),
      stage({ id: "gate", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    const span = ratifiedEvidence(p, "gate").stages.map((entry) => entry.stage.id);
    expect(span).toEqual(["early", "skipped-gate", "gate"]);
  });

  it("leaves out a stage that has not settled, because there is no outcome to accept", () => {
    const p = pipeline([
      stage({ id: "pending", status: "pending" }),
      stage({ id: "gate", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    expect(ratifiedEvidence(p, "gate").stages.map((e) => e.stage.id)).toEqual(["gate"]);
  });

  it("names the weakest thing in the span", () => {
    const p = pipeline([
      verified("build"),
      stage({ id: "promote" }),
      stage({ id: "gate", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    expect(ratifiedEvidence(p, "gate").weakest?.stage.id).toBe("promote");
  });

  it("returns an empty span for a stage that is not in the pipeline", () => {
    // Feeds a gate's presentation, and a row that fails to render is worse than one
    // that says less.
    expect(ratifiedEvidence(pipeline([]), "nope")).toEqual({ stages: [], selfReported: [] });
  });
});

describe("summariseRatified", () => {
  it("says nothing when every stage behind the gate is backed by a check", () => {
    // Silent on a backed span. A reassurance printed at every gate is read as
    // decoration and then not read at all.
    const p = pipeline([
      verified("build"),
      stage({ id: "gate", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    expect(summariseRatified(ratifiedEvidence(p, "gate"))).toBeUndefined();
  });

  it("excludes the gate stage itself", () => {
    // Measured on the live state file: including it fired on 9 of 9 gates, 3 of them
    // saying only that a human gate is answered by a human -- and `approvalAdvice`
    // already prints a self-reported line for the gate stage.
    const p = pipeline([
      verified("build"),
      stage({ id: "gate", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    expect(ratifiedEvidence(p, "gate").selfReported).toEqual([]);
  });

  it("names the unbacked stages behind the gate", () => {
    // The NMGB-2814 case: a promotion backed by the agent's own report, presented at
    // the next gate exactly as one behind a green build.
    const p = pipeline([
      verified("build"),
      stage({ id: "promote", name: "Promote to UAT" }),
      stage({ id: "gate", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    const line = summariseRatified(ratifiedEvidence(p, "gate"));
    expect(line).toContain('"Promote to UAT"');
    expect(line).toContain("1 of the 3");
  });

  it("abbreviates a long list rather than printing every name", () => {
    const p = pipeline([
      ...["a", "b", "c", "d", "e"].map((id) => stage({ id, name: id.toUpperCase() })),
      stage({ id: "gate", requiresApproval: true, status: "awaiting-approval" }),
    ]);
    expect(summariseRatified(ratifiedEvidence(p, "gate"))).toContain("and 2 more");
  });
});
