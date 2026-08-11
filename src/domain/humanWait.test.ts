import { describe, expect, it } from "vitest";
import {
  HumanWaitTally,
  humanWaitOf,
  humanWaitTotal,
  waitedMs,
  withHumanWait,
} from "./humanWait";
import { Subtask, SubtaskActivity } from "./taskPipeline";
import { subtasksUsage, workingMs } from "./stageUsage";

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: "s1",
    title: "Implement the data",
    prompt: "do it",
    status: "done",
    startedAt: "2026-08-11T09:00:00.000Z",
    finishedAt: "2026-08-11T09:10:00.000Z",
    ...overrides,
  };
}

describe("waitedMs", () => {
  it("measures the gap between two timestamps", () => {
    expect(waitedMs("2026-08-11T09:00:00.000Z", "2026-08-11T09:00:45.000Z")).toBe(45_000);
  });

  // A negative wait would be subtracted from working time, making a stage look faster
  // because a clock skewed.
  it("clamps a backwards pair to zero rather than going negative", () => {
    expect(waitedMs("2026-08-11T09:01:00.000Z", "2026-08-11T09:00:00.000Z")).toBe(0);
  });

  it("is zero when either timestamp is unusable", () => {
    expect(waitedMs("not a date", "2026-08-11T09:00:00.000Z")).toBe(0);
    expect(waitedMs("2026-08-11T09:00:00.000Z", "")).toBe(0);
  });
});

describe("withHumanWait", () => {
  it("records a wait on an activity that had none", () => {
    const activity = withHumanWait({ toolCounts: { Bash: 2 } }, 30_000);
    expect(activity?.blockedOnHumanMs).toBe(30_000);
    expect(activity?.toolCounts).toEqual({ Bash: 2 });
  });

  // A real stage called ask_user twice in one session, so the second wait must add to
  // the first rather than replace it.
  it("accumulates across several waits in one subtask", () => {
    const once = withHumanWait(undefined, 20_000);
    const twice = withHumanWait(once, 15_000);
    expect(twice?.blockedOnHumanMs).toBe(35_000);
  });

  it("creates a record for a session that asked and then reported nothing", () => {
    expect(withHumanWait(undefined, 5_000)).toEqual({ blockedOnHumanMs: 5_000 });
  });

  // A route that never asked anything must round-trip without gaining a zero field,
  // so a stored pipeline is not rewritten by merely being read.
  it("leaves the activity alone when there is nothing to add", () => {
    const original: SubtaskActivity = { toolCounts: { Read: 1 } };
    expect(withHumanWait(original, 0)).toBe(original);
    expect(withHumanWait(original, -100)).toBe(original);
    expect(withHumanWait(undefined, 0)).toBeUndefined();
  });

  it("does not mutate what it is given", () => {
    const original: SubtaskActivity = { toolCounts: { Read: 1 } };
    withHumanWait(original, 1_000);
    expect(original.blockedOnHumanMs).toBeUndefined();
  });
});

describe("humanWaitOf", () => {
  it("reads a recorded wait", () => {
    expect(humanWaitOf(subtask({ activity: { blockedOnHumanMs: 9_000 } }))).toBe(9_000);
  });

  // Absence means unmeasured, and zero is the only honest answer a caller can add up.
  it("is zero for a subtask that recorded nothing", () => {
    expect(humanWaitOf(subtask())).toBe(0);
    expect(humanWaitOf(subtask({ activity: {} }))).toBe(0);
  });

  it("ignores a nonsense value rather than propagating it", () => {
    expect(
      humanWaitOf(subtask({ activity: { blockedOnHumanMs: -5 } })),
    ).toBe(0);
    expect(
      humanWaitOf(subtask({ activity: { blockedOnHumanMs: Number.NaN } })),
    ).toBe(0);
  });

  it("totals across subtasks", () => {
    expect(
      humanWaitTotal([
        subtask({ id: "a", activity: { blockedOnHumanMs: 1_000 } }),
        subtask({ id: "b", activity: { blockedOnHumanMs: 2_500 } }),
        subtask({ id: "c" }),
      ]),
    ).toBe(3_500);
  });
});

describe("HumanWaitTally", () => {
  it("accumulates per task and keeps tasks apart", () => {
    const tally = new HumanWaitTally();
    tally.add("t1", 1_000);
    tally.add("t1", 2_000);
    tally.add("t2", 500);
    expect(tally.total("t1")).toBe(3_000);
    expect(tally.total("t2")).toBe(500);
    expect(tally.total("t3")).toBe(0);
  });

  it("ignores nothing-to-add", () => {
    const tally = new HumanWaitTally();
    tally.add("t1", 0);
    tally.add("t1", -10);
    tally.add("t1", Number.NaN);
    expect(tally.total("t1")).toBe(0);
  });

  it("forgets a task", () => {
    const tally = new HumanWaitTally();
    tally.add("t1", 1_000);
    tally.forget("t1");
    expect(tally.total("t1")).toBe(0);
  });
});

describe("usage totals with a human wait", () => {
  it("reports the wait beside the elapsed time and derives the working time", () => {
    const totals = subtasksUsage([
      subtask({
        startedAt: "2026-08-11T09:00:00.000Z",
        finishedAt: "2026-08-11T09:32:00.000Z",
        activity: { costUsd: 9.67, blockedOnHumanMs: 12 * 60_000 },
      }),
    ]);
    expect(totals.elapsedMs).toBe(32 * 60_000);
    expect(totals.blockedOnHumanMs).toBe(12 * 60_000);
    expect(workingMs(totals)).toBe(20 * 60_000);
  });

  // The measurement this exists to correct: without the wait, a stage that spent a
  // third of its span waiting on an answer reports that third as execution.
  it("leaves working time equal to elapsed when nothing was recorded", () => {
    const totals = subtasksUsage([subtask({ activity: { costUsd: 1 } })]);
    expect(totals.blockedOnHumanMs).toBe(0);
    expect(workingMs(totals)).toBe(totals.elapsedMs);
  });

  it("clamps rather than reporting negative work when a wait exceeds the span", () => {
    const totals = subtasksUsage([
      subtask({
        startedAt: "2026-08-11T09:00:00.000Z",
        finishedAt: "2026-08-11T09:01:00.000Z",
        activity: { blockedOnHumanMs: 5 * 60_000 },
      }),
    ]);
    expect(workingMs(totals)).toBe(0);
  });

  it("counts a wait on a subtask that reported no cost or tokens", () => {
    const totals = subtasksUsage([
      subtask({ activity: { blockedOnHumanMs: 4_000 } }),
    ]);
    expect(totals.blockedOnHumanMs).toBe(4_000);
    expect(totals.unmeasured).toBe(1);
  });
});
