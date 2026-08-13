import { describe, expect, it } from "vitest";
import { gateWaits, hasGateWait, summariseGateWait, waitOwnerOf } from "./gateWait";
import { InterventionRecord } from "./interventions";
import { TaskPipeline, TaskStage } from "./taskPipeline";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-08-13T12:00:00.000Z");

const gate = (over: Partial<TaskStage> = {}): TaskStage =>
  ({
    id: "signoff",
    name: "Human sign-off on the DEV site",
    kind: "humanVerification",
    status: "passed",
    intent: "",
    splittable: false,
    requiresApproval: true,
    subtasks: [],
    ...over,
  }) as TaskStage;

const pipeline = (
  stages: TaskStage[],
  interventions?: InterventionRecord[],
): TaskPipeline =>
  ({ routeId: "report-change", stages, interventions }) as TaskPipeline;

const approval = (stageId: string, iso: string): InterventionRecord => ({
  kind: "approval",
  stageId,
  at: iso,
});

describe("waitOwnerOf", () => {
  it("is yours unless the gate says otherwise", () => {
    // Defaulting the other way would move time out of the column the harness is
    // judged on and into the one it is excused for.
    expect(waitOwnerOf(gate())).toBe("you");
    expect(waitOwnerOf(gate({ checklistAudience: "self" }))).toBe("you");
    expect(waitOwnerOf(gate({ checklistAudience: "others" }))).toBe("others");
  });

  it("is yours for an approval gate that is not a verification at all", () => {
    expect(waitOwnerOf(gate({ kind: "deployment", checklistAudience: undefined }))).toBe(
      "you",
    );
  });
});

describe("gateWaits", () => {
  it("measures from the gate settling to the approval that ended it", () => {
    const p = pipeline(
      [gate({ finishedAt: "2026-08-11T09:00:00.000Z" })],
      [approval("signoff", "2026-08-13T09:00:00.000Z")],
    );
    const [wait] = gateWaits(p, NOW);
    expect(wait.ms).toBe(2 * DAY);
    expect(wait.open).toBe(false);
    expect(wait.until).toBe("2026-08-13T09:00:00.000Z");
  });

  it("measures an open wait to now, and says it is open", () => {
    const p = pipeline([
      gate({ status: "awaiting-approval", finishedAt: "2026-08-13T09:00:00.000Z" }),
    ]);
    const [wait] = gateWaits(p, NOW);
    expect(wait.ms).toBe(3 * HOUR);
    expect(wait.open).toBe(true);
    expect(wait.until).toBeUndefined();
  });

  it("ignores an approval from a run since discarded", () => {
    // A re-opened stage overwrites finishedAt, so only approvals at or after the
    // current wait belong to it.
    const p = pipeline(
      [gate({ finishedAt: "2026-08-13T09:00:00.000Z" })],
      [
        approval("signoff", "2026-08-01T09:00:00.000Z"),
        approval("signoff", "2026-08-13T10:00:00.000Z"),
      ],
    );
    expect(gateWaits(p, NOW)[0].ms).toBe(HOUR);
  });

  it("takes the first approval after the wait began, not the last", () => {
    const p = pipeline(
      [gate({ finishedAt: "2026-08-13T09:00:00.000Z" })],
      [
        approval("signoff", "2026-08-13T11:00:00.000Z"),
        approval("signoff", "2026-08-13T10:00:00.000Z"),
      ],
    );
    expect(gateWaits(p, NOW)[0].ms).toBe(HOUR);
  });

  it("skips a stage that never reached a gate", () => {
    expect(gateWaits(pipeline([gate({ status: "pending" })]), NOW)).toEqual([]);
    expect(gateWaits(pipeline([gate({ status: "active" })]), NOW)).toEqual([]);
    expect(
      gateWaits(pipeline([gate({ requiresApproval: false, finishedAt: "2026-08-13T09:00:00.000Z" })]), NOW),
    ).toEqual([]);
  });

  it("omits a gate with nothing to measure rather than calling it instant", () => {
    expect(gateWaits(pipeline([gate({ finishedAt: undefined })]), NOW)).toEqual([]);
    expect(gateWaits(pipeline([gate({ finishedAt: "not a date" })]), NOW)).toEqual([]);
  });

  it("does not let a skewed clock produce a negative wait", () => {
    const p = pipeline(
      [gate({ finishedAt: "2026-08-13T09:00:00.000Z" })],
      [approval("signoff", "2026-08-13T08:00:00.000Z")],
    );
    // The early approval is not a valid end for this wait, so it stays open.
    expect(gateWaits(p, NOW)[0].ms).toBe(3 * HOUR);
    expect(gateWaits(p, NOW)[0].open).toBe(true);
  });

  it("keeps route order", () => {
    const p = pipeline(
      [
        gate({ id: "local", name: "Local", finishedAt: "2026-08-13T09:00:00.000Z" }),
        gate({ id: "signoff", finishedAt: "2026-08-13T10:00:00.000Z" }),
      ],
      [approval("local", "2026-08-13T09:30:00.000Z")],
    );
    expect(gateWaits(p, NOW).map((w) => w.stageId)).toEqual(["local", "signoff"]);
  });
});

describe("summariseGateWait", () => {
  it("splits closed waits by whose they were", () => {
    const p = pipeline(
      [
        gate({ id: "local", name: "Local", finishedAt: "2026-08-13T09:00:00.000Z" }),
        gate({
          id: "signoff",
          checklistAudience: "others",
          finishedAt: "2026-08-11T09:00:00.000Z",
        }),
      ],
      [
        approval("local", "2026-08-13T10:00:00.000Z"),
        approval("signoff", "2026-08-13T09:00:00.000Z"),
      ],
    );
    const summary = summariseGateWait(p, NOW);
    expect(summary.yoursMs).toBe(HOUR);
    expect(summary.othersMs).toBe(2 * DAY);
    expect(summary.openYoursMs).toBe(0);
    expect(summary.openOthersMs).toBe(0);
  });

  it("keeps an open wait out of the closed totals", () => {
    // A growing number folded into a total makes one that changes every render,
    // which reads as the measurement being unreliable.
    const p = pipeline([
      gate({
        status: "awaiting-approval",
        checklistAudience: "others",
        finishedAt: "2026-08-13T09:00:00.000Z",
      }),
    ]);
    const summary = summariseGateWait(p, NOW);
    expect(summary.othersMs).toBe(0);
    expect(summary.openOthersMs).toBe(3 * HOUR);
  });

  it("counts a gate it could not measure", () => {
    const summary = summariseGateWait(pipeline([gate({ finishedAt: undefined })]), NOW);
    expect(summary.unmeasured).toBe(1);
    expect(summary.yoursMs).toBe(0);
  });

  it("counts an approved gate with no recorded approval as still waiting, not measured away", () => {
    // The approval happened — the stage passed — but nothing timestamped it, which
    // is what a call site with no clock leaves behind.
    const p = pipeline([gate({ finishedAt: "2026-08-13T09:00:00.000Z" })]);
    const summary = summariseGateWait(p, NOW);
    expect(summary.openYoursMs).toBe(3 * HOUR);
    expect(summary.unmeasured).toBe(0);
  });

  it("reports nothing for a route that has not reached a gate", () => {
    const summary = summariseGateWait(pipeline([gate({ status: "pending" })]), NOW);
    expect(hasGateWait(summary)).toBe(false);
  });

  it("has something to show once a gate has waited", () => {
    const p = pipeline([
      gate({ status: "awaiting-approval", finishedAt: "2026-08-13T09:00:00.000Z" }),
    ]);
    expect(hasGateWait(summariseGateWait(p, NOW))).toBe(true);
  });
});
