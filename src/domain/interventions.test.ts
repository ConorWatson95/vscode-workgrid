import { describe, expect, it } from "vitest";
import { appendIntervention, summariseInterventions } from "./interventions";

describe("appendIntervention", () => {
  it("appends without mutating what it was given", () => {
    const existing = [{ kind: "approval" as const, at: "2026-08-07T09:00:00Z" }];
    const next = appendIntervention(existing, { kind: "answer", at: "2026-08-07T10:00:00Z" });
    expect(existing).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it("starts a list when there was none", () => {
    expect(appendIntervention(undefined, { kind: "skip", at: "x" })).toEqual([
      { kind: "skip", at: "x" },
    ]);
  });
});

describe("summariseInterventions", () => {
  it("reports nothing for a route nobody has touched", () => {
    const summary = summariseInterventions(undefined);
    expect(summary.total).toBe(0);
    expect(summary.worstStage).toBeUndefined();
  });

  // "Twelve interventions" does not say whether the route asks too many questions
  // or fails too often, and those have opposite fixes.
  it("splits the total by kind", () => {
    const summary = summariseInterventions([
      { kind: "approval", at: "a" },
      { kind: "approval", at: "b" },
      { kind: "answer", at: "c" },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.byKind).toEqual({ approval: 2, answer: 1 });
  });

  it("ranks stages by attention needed and names the worst", () => {
    const summary = summariseInterventions([
      { kind: "approval", stageId: "build", at: "a" },
      { kind: "permission", stageId: "deploy", at: "b" },
      { kind: "answer", stageId: "deploy", at: "c" },
    ]);
    expect(summary.byStage).toEqual([
      { stageId: "deploy", count: 2 },
      { stageId: "build", count: 1 },
    ]);
    expect(summary.worstStage).toEqual({ stageId: "deploy", count: 2 });
  });

  // An unstable ranking in a report reads as the numbers having changed.
  it("breaks ties by stage id so the order is stable", () => {
    const summary = summariseInterventions([
      { kind: "approval", stageId: "zeta", at: "a" },
      { kind: "approval", stageId: "alpha", at: "b" },
    ]);
    expect(summary.byStage.map((s) => s.stageId)).toEqual(["alpha", "zeta"]);
  });

  it("counts an intervention belonging to no stage in the total only", () => {
    const summary = summariseInterventions([{ kind: "answer", at: "a" }]);
    expect(summary.total).toBe(1);
    expect(summary.byStage).toEqual([]);
  });
});
