/**
 * Which agent processes the harness started, and which of them it may reap.
 *
 * `AgentSessionManager` keeps its sessions in a `Map<taskId, ClaudeStreamSession>`
 * and `stop()` calls `child.kill()`, so stopping a task really does terminate its
 * process, and `dispose()` reaps every session when the extension deactivates
 * cleanly. What none of that survives is the extension host **crashing**: the map
 * goes with it, and a live stage session keeps running with no record of its pid, no
 * owner, and nothing that will ever kill it.
 *
 * This module is the durable half. The registry records what was spawned; this
 * decides what to do with each record on the next activation, given what the OS says
 * is still alive.
 *
 * ## The rule that matters most: only ever reap what we started
 *
 * Written after nearly getting this exactly wrong. Investigating a stopped task on
 * 26 Aug 2026 I listed every `claude.exe` on the machine, found three that had been
 * running for two days, and called them orphaned stage sessions. They were the
 * operator's Claude Code **chat tabs**, and one of them was the session having the
 * conversation. A sweep keyed on the process name would have killed all three.
 *
 * The tell was in the command line, and it is the same tell this module relies on:
 * a stage session carries `--plugin-dir`, `--mcp-config` and `--tools`; an
 * interactive chat session carries `--replay-user-messages` and
 * `--include-partial-messages` and none of the three. But the honest fix is not a
 * better classifier — it is to never classify at all. **A process is a candidate
 * only because the harness wrote a record when it spawned it.** Anything unrecorded
 * is somebody else's, whatever it looks like.
 *
 * ## And never on a pid alone
 *
 * Pids are reused. A record whose process died during a crash may name a pid that
 * now belongs to something unrelated — quite possibly one of those chat sessions. So
 * liveness is necessary and not sufficient: the probe must also say the process
 * started when we say we started it. Where the platform cannot tell us, the answer
 * is `keep`, not `kill`, which is the direction `WorktreeDiscardService` and the
 * unmeasured-wait rule already choose: absence of measurement is not permission to
 * act.
 *
 * Pure and vscode-free.
 */

/** What the registry wrote when a session was spawned. */
export interface SessionProcessRecord {
  /** OS process id of the CLI we spawned. */
  pid: number;
  /** The task the session belongs to. */
  taskId: string;
  /**
   * The subtask it was spawned for, absent for a hand-driven chat session.
   *
   * Absent is what makes a chat session unreapable by construction rather than by a
   * check somebody could get wrong: with no subtask there is nothing to have gone
   * inactive, so the decision below can only ever `keep` it. That is the same line
   * `--tools` and the protocol skill draw — the runtime narrows a stage, never a
   * person.
   */
  subtaskId?: string;
  /** Stage name, for the message only. */
  stageName?: string;
  /** When the harness spawned it, by the harness's clock. */
  startedAt: string;
}

/** What the OS says about one recorded pid. */
export interface ProbedProcess {
  pid: number;
  alive: boolean;
  /**
   * When the OS says the process started, if the platform could say.
   *
   * Undefined means unknown, which is a `keep` — see the module note. It is not the
   * same as a mismatch.
   */
  osStartedAt?: string;
}

/** What to do with a record. */
export type SessionProcessAction =
  /** Terminate it: ours, alive, and its subtask is no longer running. */
  | "kill"
  /** Leave it alone. */
  | "keep"
  /** Drop the record: the process is gone, or the pid is now somebody else's. */
  | "forget";

export interface SessionProcessDecision {
  record: SessionProcessRecord;
  action: SessionProcessAction;
  /** Why, in words fit for the log — a killed process must never be a silent event. */
  reason: string;
}

/**
 * How far apart the harness's clock and the OS's may be before a pid is treated as
 * somebody else's.
 *
 * Generous on purpose. The two readings are taken at slightly different moments and
 * from different clocks, so a small gap is normal; a *reused* pid, by contrast,
 * belongs to a process that started after ours died, which on a crashed host means
 * minutes or days later. Being generous errs towards `keep`.
 */
const START_TOLERANCE_MS = 5 * 60_000;

function millis(at: string | undefined): number | undefined {
  if (!at) return undefined;
  const value = Date.parse(at);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Decides what to do with each recorded process.
 *
 * `activeSubtaskIds` is every subtask the pipeline currently considers running. A
 * record naming anything else has outlived its work — including a subtask that was
 * reverted by a stop, a question or a transient failure, which is the case a
 * stage-comparison test would miss because the stage never changed.
 */
export function decideSessionProcesses(
  records: readonly SessionProcessRecord[],
  probes: readonly ProbedProcess[],
  activeSubtaskIds: ReadonlySet<string>,
): SessionProcessDecision[] {
  const probeOf = new Map(probes.map((probe) => [probe.pid, probe]));

  return records.map((record) => {
    const probe = probeOf.get(record.pid);

    if (!probe || !probe.alive) {
      return { record, action: "forget" as const, reason: "process is no longer running" };
    }

    // A pid that is alive but started long after we recorded it is a different
    // process wearing the same number. Forget the record rather than keeping it, or
    // the same wrong pid is reconsidered on every activation.
    const ours = millis(record.startedAt);
    const theirs = millis(probe.osStartedAt);
    if (ours !== undefined && theirs !== undefined && Math.abs(theirs - ours) > START_TOLERANCE_MS) {
      return {
        record,
        action: "forget" as const,
        reason: "pid has been reused by an unrelated process",
      };
    }

    if (!record.subtaskId) {
      return { record, action: "keep" as const, reason: "a hand-driven session, not a stage" };
    }

    if (activeSubtaskIds.has(record.subtaskId)) {
      return { record, action: "keep" as const, reason: "its subtask is still running" };
    }

    // Ours, alive, and orphaned — but only killable if the platform corroborated the
    // identity. Unknown start time means we cannot rule out a reused pid, and killing
    // on liveness alone is how a sweep reaches somebody else's process.
    if (theirs === undefined) {
      return {
        record,
        action: "keep" as const,
        reason: "cannot confirm this is still our process, so leaving it",
      };
    }

    const where = record.stageName ? ` for "${record.stageName}"` : "";
    return {
      record,
      action: "kill" as const,
      reason: `orphaned by an unclean shutdown${where}: its subtask is no longer running`,
    };
  });
}

/**
 * A one-line summary for the activation log.
 *
 * Announced rather than silent, the rule a discarded file and truncated output both
 * follow: this is the one part of the runtime that terminates something, and a kill
 * nobody can see afterwards is indistinguishable from a process that was never
 * there. Returns undefined when nothing happened, so a quiet activation stays quiet
 * — the rule `summariseEvidence` follows.
 */
export function summariseSessionProcesses(
  decisions: readonly SessionProcessDecision[],
): string | undefined {
  const killed = decisions.filter((decision) => decision.action === "kill");
  const unsure = decisions.filter(
    (decision) => decision.action === "keep" && decision.reason.startsWith("cannot confirm"),
  );
  if (killed.length === 0 && unsure.length === 0) return undefined;

  const parts: string[] = [];
  if (killed.length > 0) {
    parts.push(
      `reaped ${killed.length} agent process(es) left by an unclean shutdown ` +
        `(${killed.map((decision) => decision.record.pid).join(", ")})`,
    );
  }
  if (unsure.length > 0) {
    parts.push(
      `left ${unsure.length} alone because the platform could not confirm they are ours`,
    );
  }
  return parts.join("; ");
}
