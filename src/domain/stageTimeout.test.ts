import { describe, expect, it } from "vitest";
import { stageTimeoutDecision } from "./stageTimeout";

const MINUTE = 60_000;

describe("stageTimeoutDecision", () => {
  it("expires when the whole elapsed time was working", () => {
    expect(stageTimeoutDecision(45 * MINUTE, 45 * MINUTE, 0)).toEqual({ kind: "expired" });
  });

  it("re-arms for the wait, so a question outlives the stage timeout", () => {
    // 50 minutes elapsed, 40 of them waiting on an answer: 10 minutes of working time
    // against a 45-minute budget.
    expect(stageTimeoutDecision(50 * MINUTE, 45 * MINUTE, 40 * MINUTE)).toEqual({
      kind: "rearm",
      afterMs: 35 * MINUTE,
    });
  });

  it("treats an unmeasured wait as working time", () => {
    // The pre-existing behaviour, kept wherever the ask channel cannot report.
    expect(stageTimeoutDecision(45 * MINUTE, 45 * MINUTE, undefined)).toEqual({
      kind: "expired",
    });
  });

  it("floors a re-arm rather than spinning on an open wait", () => {
    // A wait still in flight leaves the remaining budget at ~0, which would fire again
    // immediately for as long as nobody answers.
    const decision = stageTimeoutDecision(90 * MINUTE, 45 * MINUTE, 45 * MINUTE - 1);
    expect(decision).toEqual({ kind: "rearm", afterMs: 30_000 });
  });

  it("clamps a wait that outruns the elapsed time", () => {
    // The tally is per task and survives a subtask, so a slipped sampling must not
    // make the budget unbounded.
    expect(stageTimeoutDecision(45 * MINUTE, 45 * MINUTE, 999 * MINUTE)).toEqual({
      kind: "expired",
    });
  });
});
