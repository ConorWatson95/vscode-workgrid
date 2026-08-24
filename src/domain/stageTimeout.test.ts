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
    // A stage that had nearly used its budget and is now blocked: the remaining budget
    // is ~0 and the open wait keeps growing, so an unfloored re-arm fires again
    // immediately for as long as nobody answers.
    const elapsed = 45 * MINUTE + 40 * MINUTE - 1;
    expect(stageTimeoutDecision(elapsed, 45 * MINUTE, 40 * MINUTE)).toEqual({
      kind: "rearm",
      afterMs: 30_000,
    });
  });

  it("never credits more wait than time that has passed", () => {
    // The tally is per task and survives a subtask, so a slipped sampling could read
    // more wait than this session has existed for. Working time floors at zero rather
    // than going negative and buying a budget longer than the setting.
    expect(stageTimeoutDecision(45 * MINUTE, 45 * MINUTE, 999 * MINUTE)).toEqual({
      kind: "rearm",
      afterMs: 45 * MINUTE,
    });
  });
});
