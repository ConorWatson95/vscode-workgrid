import { describe, expect, it } from "vitest";
import {
  answeredFailures,
  describeDisposition,
  summariseFailures,
} from "./failureHistory";
import { FailedRun, TaskPipeline } from "./taskPipeline";

const entry = (overrides: Partial<FailedRun> = {}): FailedRun => ({
  stageId: "implement",
  stageName: "Implement the data",
  subtaskId: "implement-1",
  at: "2026-09-07T10:00:00.000Z",
  reason: "exit 2",
  round: 0,
  ...overrides,
});

const pipeline = (failures?: FailedRun[]): TaskPipeline => ({
  routeId: "report-change",
  stages: [
    {
      id: "implement",
      name: "Implement the data",
      kind: "implementation",
      status: "pending",
      intent: "Do it.",
      splittable: false,
      requiresApproval: false,
      subtasks: [],
    },
  ],
  ...(failures ? { failures } : {}),
});

describe("summariseFailures", () => {
  it("says nothing at all when a route has not failed", () => {
    // The rule `summariseEvidence` follows: a reassurance on every report is read as
    // decoration and then not read.
    expect(summariseFailures(pipeline())).toBeUndefined();
    expect(summariseFailures(pipeline([]))).toBeUndefined();
    expect(summariseFailures(undefined)).toBeUndefined();
  });

  it("counts each disposition in reading order", () => {
    const summary = summariseFailures(
      pipeline([
        entry({ disposition: "reverted" }),
        entry({ disposition: "repaired" }),
        entry({ disposition: "transient" }),
        entry({ disposition: "repaired" }),
      ]),
    )!;
    expect(summary.total).toBe(4);
    expect(summary.answered).toEqual([
      { disposition: "repaired", times: 2 },
      { disposition: "reverted", times: 1 },
      { disposition: "transient", times: 1 },
    ]);
  });

  it("reports unanswered failures apart from the answered counts", () => {
    // The load-bearing figure: a failure nobody responded to is a route that stopped,
    // and folding it into a total is what made that invisible.
    const summary = summariseFailures(
      pipeline([entry({ disposition: "retried" }), entry(), entry()]),
    )!;
    expect(summary.unanswered).toBe(2);
    expect(summary.answered).toEqual([{ disposition: "retried", times: 1 }]);
    expect(summary.total).toBe(3);
  });

  it("names the stages that failed more than once, worst first", () => {
    const summary = summariseFailures(
      pipeline([
        entry({ stageId: "plan", stageName: "Plan" }),
        entry({ stageId: "implement" }),
        entry({ stageId: "implement" }),
        entry({ stageId: "implement" }),
        entry({ stageId: "plan", stageName: "Plan" }),
      ]),
    )!;
    expect(summary.worst).toEqual([
      { stageId: "implement", stageName: "Implement the data", times: 3 },
      { stageId: "plan", stageName: "Plan", times: 2 },
    ]);
  });

  it("leaves a stage that failed once out of the worst list", () => {
    // "×1" is not a pattern, and a list of every stage that ever failed is one nobody
    // reads for the stage that keeps failing.
    const summary = summariseFailures(
      pipeline([entry({ stageId: "plan", stageName: "Plan" }), entry()]),
    )!;
    expect(summary.worst).toEqual([]);
  });

  it("caps the worst list where the caller asks", () => {
    const many = ["a", "b", "c", "d"].flatMap((id) => [
      entry({ stageId: id, stageName: id }),
      entry({ stageId: id, stageName: id }),
    ]);
    expect(summariseFailures(pipeline(many), 2)!.worst).toHaveLength(2);
  });
});

describe("answeredFailures", () => {
  it("returns this stage's answered failures only", () => {
    const failures = [
      entry({ disposition: "retried", reason: "mine" }),
      entry({ stageId: "plan", stageName: "Plan", disposition: "reverted" }),
    ];
    const found = answeredFailures(pipeline(failures), { id: "implement" });
    expect(found.map((f) => f.reason)).toEqual(["mine"]);
  });

  it("withholds an undecided failure, which the report already shows as current", () => {
    // Every responder that records a disposition also clears the subtask's own reason,
    // so an undecided entry is the live failure — rendering it here would print the
    // same event twice and give the reader two counts of it.
    const found = answeredFailures(pipeline([entry()]), { id: "implement" });
    expect(found).toEqual([]);
  });
});

describe("describeDisposition", () => {
  it("keeps a repair and a re-run distinguishable in words", () => {
    // The distinction is the only thing the ledger was added to measure: one carried a
    // finding to the stage that owed it, the other started the same stage again.
    expect(describeDisposition("repaired")).not.toBe(describeDisposition("retried"));
    expect(describeDisposition("repaired")).toContain("owed");
    expect(describeDisposition("retried")).toContain("re-ran");
  });
});
