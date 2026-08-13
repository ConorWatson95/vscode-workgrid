import { InterventionRecord } from "./interventions";
import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * How long a route spent waiting at its gates, and whose wait it was.
 *
 * The KPI is engineering throughput per engineer, so the harness has to be able to
 * tell three things apart: time an agent was working, time it was waiting on the
 * operator, and time it was waiting on somebody else entirely. The first two are
 * measured — `stageUsage` and `humanWait` — and the third was not measured at all.
 *
 * That gap only became expensive once gates could say who answers them. A route that
 * hands its DEV sign-off to testers and its UAT acceptance to an external party can
 * sit for days without anything being wrong, and with no way to attribute that time
 * the only figure available is wall clock — in which a well-run route waiting on other
 * people is indistinguishable from a slow one. Optimising against that number sends
 * the effort at execution, which is exactly the mistake the first latency measurement
 * made for the opposite reason.
 *
 * **Derived, never recorded.** Everything here comes from state the pipeline already
 * holds: a gate's `finishedAt` is the moment it settled into `awaiting-approval`, so it
 * is when the wait *began*, and the `approval` intervention for that stage is when it
 * ended. Adding a field would mean writing it at approval time, and `interventions`
 * already establishes the rule that a call site with no clock records nothing — so a
 * derived figure inherits that honesty instead of quietly reporting zero.
 *
 * Pure and vscode-free.
 */

/** Whose wait a gate's time is. */
export type WaitOwner = "you" | "others";

export interface GateWait {
  stageId: string;
  stageName: string;
  owner: WaitOwner;
  /** When the gate settled into `awaiting-approval`. */
  since: string;
  /** When it was approved, absent while it is still waiting. */
  until?: string;
  /**
   * Milliseconds waited.
   *
   * For an open wait this is measured to whatever `now` the caller passed, and is
   * meaningless without `open` alongside it.
   */
  ms: number;
  /** True while nobody has answered it yet. */
  open: boolean;
}

/**
 * Whose gate this is.
 *
 * Defaults to `"you"`, and that direction is deliberate. An unattributed wait counted
 * as somebody else's would move time out of the column the harness is judged on and
 * into the one it is excused for — flattering the runtime for time it may genuinely
 * have cost. Only an explicit declaration moves a wait to `"others"`, exactly as an
 * unrecognised `checklistAudience` is rejected rather than defaulted.
 */
export function waitOwnerOf(stage: TaskStage): WaitOwner {
  return stage.checklistAudience === "others" ? "others" : "you";
}

/**
 * When a gate's wait ended, from the approval that ended it.
 *
 * The **first** approval at or after the wait began, not the last: a stage re-opened
 * and approved again overwrites `finishedAt`, so pairing forward from the current
 * `finishedAt` matches the wait actually being measured and ignores approvals that
 * belonged to a run since discarded.
 */
function approvedAt(
  interventions: readonly InterventionRecord[],
  stageId: string,
  since: number,
): string | undefined {
  let best: { at: string; ms: number } | undefined;
  for (const record of interventions) {
    if (record.kind !== "approval" || record.stageId !== stageId) continue;
    const ms = Date.parse(record.at);
    if (Number.isNaN(ms) || ms < since) continue;
    if (!best || ms < best.ms) best = { at: record.at, ms };
  }
  return best?.at;
}

/**
 * Every gate wait this pipeline can account for, in route order.
 *
 * Only stages that actually reached a gate: one still pending has not waited, and one
 * that passed without requiring approval never held anybody up. A gate whose
 * `finishedAt` is missing or unparseable is omitted rather than reported as zero —
 * unmeasured is a different fact from instant, and `summariseGateWait` counts it.
 *
 * `now` is passed in so an open wait can be measured without this module reading a
 * clock.
 */
export function gateWaits(
  pipeline: TaskPipeline,
  now: number,
  interventions?: readonly InterventionRecord[],
): GateWait[] {
  const records = interventions ?? pipeline.interventions ?? [];
  const waits: GateWait[] = [];

  for (const stage of pipeline.stages) {
    const reachedAGate =
      stage.status === "awaiting-approval" ||
      (stage.requiresApproval && stage.status === "passed");
    if (!reachedAGate) continue;

    const since = stage.finishedAt;
    if (!since) continue;
    const from = Date.parse(since);
    if (Number.isNaN(from)) continue;

    const until =
      stage.status === "awaiting-approval"
        ? undefined
        : approvedAt(records, stage.id, from);
    const to = until ? Date.parse(until) : now;
    if (Number.isNaN(to)) continue;

    waits.push({
      stageId: stage.id,
      stageName: stage.name,
      owner: waitOwnerOf(stage),
      since,
      ...(until ? { until } : {}),
      // Clamped for the reason every duration here is clamped: these timestamps come
      // from whatever clock wrote them, and a negative wait would reduce a total.
      ms: Math.max(0, to - from),
      open: until === undefined,
    });
  }

  return waits;
}

export interface GateWaitSummary {
  /** Closed waits, split by whose they were. */
  yoursMs: number;
  othersMs: number;
  /**
   * Waits still open right now, kept apart from the closed totals.
   *
   * A route sitting at a gate has no final figure yet, and folding a growing number
   * into a total produces one that changes on every render — which reads as the
   * measurement being unreliable rather than the wait being live.
   */
  openYoursMs: number;
  openOthersMs: number;
  /** Gates that reached approval but recorded no timestamps to measure. */
  unmeasured: number;
}

/**
 * Gate wait for a whole route.
 *
 * Reported beside execution time rather than subtracted from anything, for the same
 * reason `blockedOnHumanMs` is: the numbers come from different records, and a reader
 * who can see which is which can discount them. What it is *for* is the question
 * "should this route be faster?" — and time in `othersMs` is the part where the answer
 * is no.
 */
export function summariseGateWait(
  pipeline: TaskPipeline,
  now: number,
  interventions?: readonly InterventionRecord[],
): GateWaitSummary {
  const summary: GateWaitSummary = {
    yoursMs: 0,
    othersMs: 0,
    openYoursMs: 0,
    openOthersMs: 0,
    unmeasured: 0,
  };

  const measured = new Set<string>();
  for (const wait of gateWaits(pipeline, now, interventions)) {
    measured.add(wait.stageId);
    if (wait.open) {
      if (wait.owner === "others") summary.openOthersMs += wait.ms;
      else summary.openYoursMs += wait.ms;
    } else if (wait.owner === "others") {
      summary.othersMs += wait.ms;
    } else {
      summary.yoursMs += wait.ms;
    }
  }

  // A gate that plainly held the route up but left nothing to measure. Counted rather
  // than ignored, because a total presented as complete when it is not invites exactly
  // the comparison it cannot support — the rule `stageUsage` follows for a subtask that
  // reported no numbers.
  for (const stage of pipeline.stages) {
    if (!stage.requiresApproval) continue;
    if (stage.status !== "awaiting-approval" && stage.status !== "passed") continue;
    if (!measured.has(stage.id)) summary.unmeasured += 1;
  }

  return summary;
}

/** True when there is any gate wait worth putting on screen. */
export function hasGateWait(summary: GateWaitSummary): boolean {
  return (
    summary.yoursMs > 0 ||
    summary.othersMs > 0 ||
    summary.openYoursMs > 0 ||
    summary.openOthersMs > 0 ||
    summary.unmeasured > 0
  );
}
