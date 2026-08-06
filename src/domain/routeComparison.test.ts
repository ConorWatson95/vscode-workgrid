import { describe, expect, it } from "vitest";
import { compareArms, summariseArm } from "./routeComparison";
import { TaskPipeline, TaskStage, SubtaskActivity } from "./taskPipeline";

const activity = (input: number, costUsd = 0.5): SubtaskActivity => ({
  costUsd,
  tokens: { input, output: 100, cacheRead: 0, cacheCreation: 0 },
});

function run(
  overrides: {
    input?: number;
    status?: TaskStage["status"];
    subtaskStatus?: "done" | "failed";
    verdict?: "pass" | "block";
    measured?: boolean;
  } = {},
): TaskPipeline {
  const { input = 1000, status = "passed", subtaskStatus = "done", verdict, measured = true } =
    overrides;
  return {
    routeId: "r",
    stages: [
      {
        id: "s1",
        name: "Stage one",
        kind: "implementation",
        status,
        intent: "",
        splittable: false,
        requiresApproval: false,
        ...(verdict ? { verdict } : {}),
        subtasks: [
          {
            id: "s1-1",
            title: "t",
            prompt: "p",
            status: subtaskStatus,
            startedAt: "2026-08-06T10:00:00.000Z",
            finishedAt: "2026-08-06T10:01:00.000Z",
            ...(measured ? { activity: activity(input) } : {}),
          },
        ],
      } as TaskStage,
    ],
  };
}

describe("summariseArm", () => {
  it("sums usage across runs", () => {
    const arm = summariseArm([run({ input: 1000 }), run({ input: 500 })]);
    expect(arm.runs).toBe(2);
    expect(arm.usage.tokens.input).toBe(1500);
    expect(arm.usage.costUsd).toBeCloseTo(1);
  });

  it("counts the outcome axes, not just cost", () => {
    const arm = summariseArm([
      run({ subtaskStatus: "failed", status: "failed" }),
      run({ status: "awaiting-approval" }),
      run({ verdict: "block" }),
    ]);
    expect(arm.failedSubtasks).toBe(1);
    expect(arm.heldStages).toBe(1);
    expect(arm.blockingVerdicts).toBe(1);
  });
});

describe("compareArms", () => {
  const clean = (input: number) => [run({ input }), run({ input })];

  it("names the cheaper arm on fresh input tokens", () => {
    // Fresh input is what a rediscovering session actually spends; cacheRead is nearly
    // free, so a total would hide the effect being measured.
    const result = compareArms(clean(400), clean(1000));
    expect(result.withheld).toBeUndefined();
    expect(result.cheaperArm).toBe("a");
    expect(result.inputTokenDelta).toBe(1200);
  });

  it("withholds a verdict on one run per arm", () => {
    const result = compareArms([run({ input: 400 })], [run({ input: 1000 })]);
    expect(result.cheaperArm).toBeUndefined();
    expect(result.withheld).toContain("variance");
  });

  it("withholds a verdict when a subtask reported nothing", () => {
    // A partial total invites a comparison between arms that measured different work.
    const result = compareArms(
      [run({ input: 400 }), run({ measured: false })],
      clean(1000),
    );
    expect(result.cheaperArm).toBeUndefined();
    expect(result.withheld).toContain("no cost or tokens");
  });

  it("withholds a verdict when an arm did not run cleanly", () => {
    // The heart of it: spending less by doing less is not a saving.
    const result = compareArms(
      [run({ input: 100, subtaskStatus: "failed", status: "failed" }), run({ input: 100 })],
      clean(1000),
    );
    expect(result.cheaperArm).toBeUndefined();
    expect(result.withheld).toContain("less by doing less");
  });

  it("withholds a verdict when a held stage makes an arm look cheap", () => {
    const result = compareArms(
      [run({ input: 100, status: "awaiting-approval" }), run({ input: 100 })],
      clean(1000),
    );
    expect(result.cheaperArm).toBeUndefined();
  });

  it("withholds a verdict when an arm has no runs at all", () => {
    const result = compareArms([], clean(1000));
    expect(result.withheld).toContain("nothing to compare");
  });

  it("withholds a verdict on a tie rather than picking one", () => {
    const result = compareArms(clean(1000), clean(1000));
    expect(result.cheaperArm).toBeUndefined();
    expect(result.withheld).toContain("same fresh input tokens");
  });

  it("still reports the deltas when the verdict is withheld", () => {
    // The numbers are worth seeing even when they cannot settle the question.
    const result = compareArms([run({ input: 400 })], [run({ input: 1000 })]);
    expect(result.inputTokenDelta).toBe(600);
    expect(result.a.usage.tokens.input).toBe(400);
  });
});
