import { describe, expect, it } from "vitest";
import {
  selfReportedStages,
  stageEvidence,
  summariseEvidence,
} from "./stageEvidence";
import { TaskPipeline, TaskStage } from "./taskPipeline";

const stage = (over: Partial<TaskStage> = {}): TaskStage =>
  ({
    id: "implement",
    name: "Make the change",
    kind: "implementation",
    status: "passed",
    intent: "Do the work.",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...over,
  }) as TaskStage;

const pipe = (stages: TaskStage[]): TaskPipeline =>
  ({ routeId: "sql-change", stages }) as TaskPipeline;

describe("stageEvidence", () => {
  it("calls a stage with no check and no plan self-reported", () => {
    const evidence = stageEvidence(stage());
    expect(evidence.basis).toBe("selfReported");
    expect(evidence.selfReported).toBe(true);
    expect(evidence.summary).toMatch(/agent's own account/);
  });

  it("reads the check that ran, not the one that was declared", () => {
    // The case that motivated recording the outcome separately: a runner built
    // without a verifier leaves `verify` set and nothing executed, and the report
    // said "verified by" on the strength of the declaration alone.
    const evidence = stageEvidence(stage({ verify: "npm test" }));
    expect(evidence.selfReported).toBe(true);
    expect(evidence.summary).toMatch(/no check was recorded as having run/);
  });

  it("counts a check that ran and exited zero", () => {
    const evidence = stageEvidence(
      stage({
        verify: "npm test",
        verification: { command: "npm test", exitCode: 0, at: "2026-08-07T00:00:00.000Z" },
      }),
    );
    expect(evidence.basis).toBe("verified");
    expect(evidence.selfReported).toBe(false);
  });

  it("does not count a check that ran and failed", () => {
    // A recorded non-zero exit belongs to a stage that failed; if one somehow settles
    // it must not be presented as proven, which reading `verify` alone would do.
    const evidence = stageEvidence(
      stage({
        verify: "npm test",
        verification: { command: "npm test", exitCode: 1, at: "2026-08-07T00:00:00.000Z" },
      }),
    );
    expect(evidence.basis).toBe("selfReported");
  });

  it("counts a fully accounted plan", () => {
    const evidence = stageEvidence(
      stage({
        planFile: "plan.md",
        planSteps: [
          { number: 1, title: "Deploy", status: "done" },
          { number: 2, title: "Rebuild", status: "not-done", note: "no data" },
        ],
      }),
    );
    expect(evidence.basis).toBe("planAccounted");
    expect(evidence.selfReported).toBe(false);
  });

  it("does not count a plan with a step nobody mentioned", () => {
    const evidence = stageEvidence(
      stage({
        planFile: "plan.md",
        planSteps: [
          { number: 1, title: "Deploy", status: "done" },
          { number: 2, title: "Rebuild", status: "unaccounted" },
        ],
      }),
    );
    expect(evidence.basis).toBe("selfReported");
  });

  it("counts a stated review verdict", () => {
    const evidence = stageEvidence(stage({ kind: "domainReview", verdict: "pass" }));
    expect(evidence.basis).toBe("reviewed");
  });

  it("says a skipped stage was assessed, never that it reported anything", () => {
    const evidence = stageEvidence(
      stage({ status: "skipped", skipReason: "exists in DEV, absent from the repository" }),
    );
    expect(evidence.basis).toBe("assessed");
    // Not self-reported: this stage said nothing at all, and calling it self-reported
    // would accuse it of a claim it never made.
    expect(evidence.selfReported).toBe(false);
    expect(evidence.summary).toMatch(/exists in DEV/);
  });

  it("has nothing to say about a stage that has not settled", () => {
    expect(stageEvidence(stage({ status: "running" })).basis).toBe("none");
    expect(stageEvidence(stage({ status: "pending" })).selfReported).toBe(false);
  });
});

describe("summariseEvidence", () => {
  it("gives the proportion, naming the stages nothing checked", () => {
    const summary = summariseEvidence(
      pipe([
        stage({ id: "a", name: "Make the change" }),
        stage({
          id: "b",
          name: "Build",
          verify: "npm test",
          verification: { command: "npm test", exitCode: 0, at: "t" },
        }),
        stage({ id: "c", name: "Deploy", status: "pending" }),
      ]),
    );
    expect(summary).toMatch(/1 of 2 settled stage\(s\)/);
    expect(summary).toMatch(/Make the change/);
    expect(summary).not.toMatch(/Build/);
  });

  it("says nothing at all when every settled stage is backed", () => {
    // Undefined rather than a reassurance: a line printed on every report is read as
    // decoration and stops being read at all.
    const summary = summariseEvidence(
      pipe([
        stage({
          verify: "npm test",
          verification: { command: "npm test", exitCode: 0, at: "t" },
        }),
      ]),
    );
    expect(summary).toBeUndefined();
  });

  it("says nothing when no stage has settled", () => {
    expect(summariseEvidence(pipe([stage({ status: "pending" })]))).toBeUndefined();
  });
});

describe("selfReportedStages", () => {
  it("returns the stages resting on nothing but the agent's word", () => {
    const weak = selfReportedStages(
      pipe([stage({ id: "a" }), stage({ id: "b", verdict: "pass" })]),
    );
    expect(weak.map((s) => s.id)).toEqual(["a"]);
  });
});
