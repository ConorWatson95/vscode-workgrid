import { describe, expect, it } from "vitest";
import { correctionCost, correctionEvents } from "./correctionCost";
import { DiscardedRun, SessionTokenTotals, TaskPipeline } from "./taskPipeline";

const NO_TOKENS: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function run(over: Partial<DiscardedRun> & { stageId: string }): DiscardedRun {
  return {
    stageName: over.stageId,
    at: "2026-08-11T09:00:00.000Z",
    sessions: 1,
    tokens: NO_TOKENS,
    ...over,
  };
}

function pipelineWith(discarded: DiscardedRun[]): TaskPipeline {
  return { routeId: "r", stages: [], discarded } as unknown as TaskPipeline;
}

describe("correctionCost", () => {
  it("separates the stage that was wrong from the stages that merely followed it", () => {
    const summary = correctionCost(
      pipelineWith([
        run({ stageId: "implement", costUsd: 8 }),
        run({ stageId: "review", costUsd: 1, collateral: true }),
        run({ stageId: "deploy-dev", costUsd: 1, collateral: true }),
      ]),
    );

    expect(summary.targetCostUsd).toBe(8);
    expect(summary.collateralCostUsd).toBe(2);
    expect(summary.collateralShare).toBe(20);
  });

  it("counts a correction as pure collateral, since it keeps its own stage", () => {
    const summary = correctionCost(
      pipelineWith([run({ stageId: "review", costUsd: 0.5, collateral: true })]),
    );

    expect(summary.targetCostUsd).toBe(0);
    expect(summary.collateralShare).toBe(100);
    expect(summary.events[0].targetStageName).toBeUndefined();
  });

  it("reports no share when nothing reported cost, rather than a misleading zero", () => {
    const summary = correctionCost(
      pipelineWith([run({ stageId: "implement", elapsedMs: 60_000 })]),
    );

    expect(summary.collateralShare).toBeUndefined();
    expect(summary.targetElapsedMs).toBe(60_000);
    expect(summary.unmeasured).toBe(0);
  });

  it("counts a run that reported neither cost nor time as unmeasured", () => {
    expect(correctionCost(pipelineWith([run({ stageId: "implement" })])).unmeasured).toBe(1);
  });

  it("groups one re-open's entries into a single event, oldest first", () => {
    const events = correctionEvents(
      pipelineWith([
        run({ stageId: "deploy", at: "2026-08-11T11:00:00.000Z", collateral: true }),
        run({ stageId: "implement", at: "2026-08-11T09:00:00.000Z", costUsd: 3 }),
        run({ stageId: "review", at: "2026-08-11T09:00:00.000Z", collateral: true, costUsd: 1 }),
      ]),
    );

    expect(events).toHaveLength(2);
    expect(events[0].at).toBe("2026-08-11T09:00:00.000Z");
    expect(events[0].targetStageName).toBe("implement");
    expect(events[0].collateralStageNames).toEqual(["review"]);
    expect(events[1].collateralStageNames).toEqual(["deploy"]);
  });

  it("says nothing about a route that never went backwards", () => {
    const summary = correctionCost(pipelineWith([]));
    expect(summary.events).toEqual([]);
    expect(summary.collateralShare).toBeUndefined();
  });
});
