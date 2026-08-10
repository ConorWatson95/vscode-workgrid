import { describe, it, expect } from "vitest";
import { Subtask, SubtaskActivity, TaskPipeline, TaskStage } from "./taskPipeline";
import {
  discardedUsage,
  hasUsage,
  pipelineUsage,
  rerunCounts,
  subtasksUsage,
  survivingUsage,
} from "./stageUsage";

function subtask(over: Partial<Subtask> = {}): Subtask {
  return {
    id: "s1",
    title: "Do the thing",
    prompt: "…",
    status: "done",
    startedAt: "2026-08-05T10:00:00.000Z",
    finishedAt: "2026-08-05T10:02:00.000Z",
    ...over,
  };
}

function activity(over: Partial<SubtaskActivity> = {}): SubtaskActivity {
  return {
    costUsd: 0.5,
    tokens: { input: 1000, output: 200, cacheRead: 50_000, cacheCreation: 300 },
    ...over,
  };
}

describe("subtasksUsage", () => {
  it("sums cost and tokens across subtasks", () => {
    const totals = subtasksUsage([
      subtask({ id: "a", activity: activity() }),
      subtask({ id: "b", activity: activity() }),
    ]);
    expect(totals.costUsd).toBeCloseTo(1.0);
    expect(totals.tokens).toEqual({
      input: 2000,
      output: 400,
      cacheRead: 100_000,
      cacheCreation: 600,
    });
    expect(totals.measured).toBe(2);
    expect(totals.unmeasured).toBe(0);
  });

  it("sums time in session rather than spanning the gap between subtasks", () => {
    // Two minutes each, run an hour apart because a human sat in between. The
    // total is four minutes of agent time, not sixty-two.
    const totals = subtasksUsage([
      subtask({ id: "a", activity: activity() }),
      subtask({
        id: "b",
        startedAt: "2026-08-05T11:00:00.000Z",
        finishedAt: "2026-08-05T11:02:00.000Z",
        activity: activity(),
      }),
    ]);
    expect(totals.elapsedMs).toBe(4 * 60 * 1000);
  });

  it("counts a subtask that ran without reporting usage as unmeasured", () => {
    const totals = subtasksUsage([
      subtask({ id: "a", activity: activity() }),
      // Recorded before usage was kept: activity, but no numbers.
      subtask({ id: "b", activity: { toolCounts: { Read: 3 } } }),
      // Died before it reached a result event.
      subtask({ id: "c", status: "failed", activity: undefined }),
    ]);
    expect(totals.measured).toBe(1);
    expect(totals.unmeasured).toBe(2);
  });

  it("does not count a pending subtask as unmeasured", () => {
    // Otherwise a route reports itself as partially instrumented before it starts,
    // and the caveat that means "this total is incomplete" cries wolf.
    const totals = subtasksUsage([
      subtask({ id: "a", activity: activity() }),
      { id: "b", title: "Later", prompt: "…", status: "pending" },
    ]);
    expect(totals.unmeasured).toBe(0);
    expect(totals.measured).toBe(1);
  });

  it("keeps a subtask that reported only a cost", () => {
    const totals = subtasksUsage([
      subtask({ activity: { costUsd: 0.25, tokens: undefined } }),
    ]);
    expect(totals.measured).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.25);
  });

  it("ignores unparseable or reversed timestamps rather than subtracting", () => {
    const totals = subtasksUsage([
      subtask({ id: "a", startedAt: "not a date", finishedAt: "also not" }),
      subtask({
        id: "b",
        startedAt: "2026-08-05T10:05:00.000Z",
        finishedAt: "2026-08-05T10:00:00.000Z",
      }),
    ]);
    expect(totals.elapsedMs).toBe(0);
  });

  it("reports nothing worth showing for a route that has not run", () => {
    expect(hasUsage(subtasksUsage([]))).toBe(false);
    expect(
      hasUsage(subtasksUsage([{ id: "b", title: "Later", prompt: "…", status: "pending" }])),
    ).toBe(false);
  });
});

describe("cost that re-runs threw away", () => {
  const ran = (id: string, cost: number): TaskStage =>
    ({
      id,
      name: id,
      kind: "implementation",
      status: "passed",
      intent: "",
      splittable: false,
      requiresApproval: false,
      subtasks: [
        {
          id: `${id}-1`,
          title: "t",
          prompt: "p",
          status: "done",
          startedAt: "2026-08-10T10:00:00.000Z",
          finishedAt: "2026-08-10T10:10:00.000Z",
          activity: {
            costUsd: cost,
            tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 0 },
          },
        },
      ],
    }) as TaskStage;

  const withDiscards = (): TaskPipeline =>
    ({
      routeId: "report-change",
      stages: [ran("rc-implement", 3)],
      discarded: [
        {
          stageId: "rc-implement",
          stageName: "Implement",
          at: "t1",
          reason: 'sent back from "SQL object review"',
          costUsd: 12.48,
          tokens: { input: 1310, output: 74241, cacheRead: 15254313, cacheCreation: 177415 },
          elapsedMs: 2_624_000,
          sessions: 1,
        },
        {
          stageId: "rc-implement",
          stageName: "Implement",
          at: "t2",
          costUsd: 9,
          sessions: 1,
        },
        { stageId: "rc-review", stageName: "Code review", at: "t2", costUsd: 2, sessions: 1 },
      ],
    }) as TaskPipeline;

  it("counts discarded runs in what the route cost", () => {
    // What a route cost is what was spent on it, not what survives on it. A task sent
    // back six times reported the price of its last attempt and looked calm.
    expect(pipelineUsage(withDiscards()).costUsd).toBeCloseTo(26.48);
    expect(survivingUsage(withDiscards()).costUsd).toBe(3);
    expect(discardedUsage(withDiscards()).costUsd).toBeCloseTo(23.48);
  });

  it("adds discarded tokens too, since that is where the churn shows", () => {
    expect(pipelineUsage(withDiscards()).tokens.cacheRead).toBe(15_254_313 + 30);
  });

  it("groups re-runs by stage, dearest first", () => {
    // One costly stage re-run twice and a route that churns everywhere sum to the
    // same money and need opposite fixes, so the total alone cannot be the report.
    const counts = rerunCounts(withDiscards());
    expect(counts[0]).toMatchObject({ stageId: "rc-implement", times: 2 });
    expect(counts[0].costUsd).toBeCloseTo(21.48);
    expect(counts[1]).toMatchObject({ stageId: "rc-review", times: 1 });
  });

  it("says nothing when a route never went backwards", () => {
    const clean = { routeId: "r", stages: [ran("a", 1)] } as TaskPipeline;
    expect(hasUsage(discardedUsage(clean))).toBe(false);
    expect(pipelineUsage(clean).costUsd).toBe(1);
  });
});
