import { describe, it, expect } from "vitest";
import { positionOf, routeFrontier, isStrandedGate } from "./routePosition";
import { TaskPipeline, TaskStage } from "./taskPipeline";
import { nextAction } from "./pipelineEngine";

function stage(id: string, status: TaskStage["status"]): TaskStage {
  return {
    id,
    name: id,
    kind: "implementation",
    status,
    subtasks: status === "pending" ? [] : [{ id: `${id}-1`, brief: "b", status: "done" }],
  } as TaskStage;
}

function pipeline(...stages: TaskStage[]): TaskPipeline {
  return { routeId: "r", routeLabel: "R", stages } as TaskPipeline;
}

describe("routeFrontier", () => {
  it("is the first stage that has not resolved", () => {
    const p = pipeline(stage("a", "passed"), stage("b", "awaiting-approval"), stage("c", "passed"));
    expect(routeFrontier(p)?.id).toBe("b");
  });

  it("is nothing when every stage has resolved", () => {
    const p = pipeline(stage("a", "passed"), stage("b", "skipped"));
    expect(routeFrontier(p)).toBeUndefined();
  });

  // A marker that disagreed with the driver would be worse than no marker at all.
  it("agrees with the stage nextAction picks up", () => {
    const p = pipeline(
      stage("a", "passed"),
      stage("b", "awaiting-approval"),
      stage("c", "passed"),
      stage("d", "awaiting-approval"),
    );
    const action = nextAction(p);
    expect(action.kind === "awaitApproval" && action.stage.id).toBe(routeFrontier(p)!.id);
  });
});

describe("positionOf", () => {
  // The live shape this exists for: the route ran forward, an early stage was
  // corrected and held, and the later stages kept the settlements they had earned.
  const p = pipeline(
    stage("plan", "passed"),
    stage("implement", "awaiting-approval"),
    stage("app", "passed"),
    stage("migration-review", "awaiting-approval"),
    stage("object-review", "passed"),
    stage("build", "pending"),
  );

  it("puts the route at the first unresolved stage", () => {
    expect(positionOf(p, "implement")).toBe("at");
  });

  it("reads a resolved stage before it as behind", () => {
    expect(positionOf(p, "plan")).toBe("behind");
  });

  it("reads everything after it as ahead, whatever its own status says", () => {
    expect(positionOf(p, "app")).toBe("ahead");
    expect(positionOf(p, "migration-review")).toBe("ahead");
    expect(positionOf(p, "build")).toBe("ahead");
  });

  it("reads a stage it does not hold as behind rather than inventing a stop", () => {
    expect(positionOf(p, "nope")).toBe("behind");
  });

  it("has nothing ahead once every stage has resolved", () => {
    const done = pipeline(stage("a", "passed"), stage("b", "passed"));
    expect(positionOf(done, "b")).toBe("behind");
  });

  it("names the gate the route has already gone past, and not the one it is on", () => {
    expect(isStrandedGate(p, p.stages[3])).toBe(true);
    expect(isStrandedGate(p, p.stages[1])).toBe(false);
    // A settled stage ahead of the frontier is not an outstanding demand.
    expect(isStrandedGate(p, p.stages[2])).toBe(false);
  });
});
