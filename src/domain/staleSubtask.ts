import { TaskPipeline } from "./taskPipeline";

/**
 * An `active` subtask that cannot still be in flight.
 *
 * The state file records a subtask as `active` the moment its session starts and
 * only rewrites it when the session ends. Everything that could notice the end —
 * the session's status listener, the per-subtask timeout, the driver awaiting the
 * run — lives in the extension host's memory, so a host that dies mid-subtask
 * takes all three with it and leaves the row `active` forever. Nothing then
 * detects it: the route is not running, so no advance is there to reclaim it, and
 * Stop had nothing to write.
 *
 * That is not hypothetical. It is how "Implement the application" sat `active`
 * for two hours after its session had finished, with the reply, the activity and
 * the cost all lost — and why the reclaim has to be derivable from the state file
 * alone rather than from a timer that dies with its owner.
 */
export interface StaleSubtask {
  stageId: string;
  stageName: string;
  subtaskId: string;
  subtaskTitle: string;
  /** When it was started, when the record says. */
  startedAt?: string;
  /** How long it has been `active`, or undefined when it never recorded a start. */
  ageMs?: number;
}

export interface StaleSubtaskOptions {
  /** Now, as an ISO timestamp. Passed in, like every other clock here. */
  now: string;
  /**
   * How long an unowned `active` subtask must have been running before it is
   * assumed abandoned.
   *
   * Load-bearing, and not merely a safety margin: the state file is shared by
   * every worktree of a repository, so a second window — or a headless run — may
   * legitimately own a subtask this host has never heard of. Past the stage
   * timeout no *live* owner would still be running it, because the owner's own
   * timeout would have failed it first, which is what makes age a sound proxy for
   * "nobody is coming back for this".
   */
  thresholdMs: number;
  /**
   * Whether this host started the subtask. An owned one is left entirely alone,
   * however old: it has a live session, a live timeout and a live driver, and all
   * three are better placed to end it than a sweep is.
   */
  owned: (subtaskId: string) => boolean;
}

/**
 * The `active` subtasks of a pipeline that no live run can account for.
 *
 * Pure, and deliberately conservative in both directions: reclaiming a subtask
 * that really is running discards work in flight, while leaving one wedges the
 * task until somebody notices by eye.
 */
export function staleActiveSubtasks(
  pipeline: TaskPipeline | undefined,
  options: StaleSubtaskOptions,
): StaleSubtask[] {
  if (!pipeline) return [];
  const now = Date.parse(options.now);
  const stale: StaleSubtask[] = [];

  for (const stage of pipeline.stages) {
    for (const subtask of stage.subtasks) {
      if (subtask.status !== "active") continue;
      if (options.owned(subtask.id)) continue;

      const started = subtask.startedAt ? Date.parse(subtask.startedAt) : undefined;
      // An `active` subtask with no start time cannot be aged, and the threshold
      // is the only thing protecting another host's work — so an unreadable or
      // missing timestamp is treated as stale rather than skipped. `startSubtask`
      // always records one, so this is a corrupt or hand-edited record, and the
      // recoverable reading of it is the one that unwedges the task.
      const ageMs =
        started !== undefined && Number.isFinite(started) && Number.isFinite(now)
          ? now - started
          : undefined;
      if (ageMs !== undefined && ageMs < options.thresholdMs) continue;

      stale.push({
        stageId: stage.id,
        stageName: stage.name,
        subtaskId: subtask.id,
        subtaskTitle: subtask.title,
        ...(subtask.startedAt ? { startedAt: subtask.startedAt } : {}),
        ...(ageMs !== undefined ? { ageMs } : {}),
      });
    }
  }

  return stale;
}

/** How a reclaim reads in a log line or a notification. */
export function describeStaleSubtask(stale: StaleSubtask): string {
  const age =
    stale.ageMs !== undefined
      ? `active for ${Math.round(stale.ageMs / 60000)} minute(s)`
      : "active with no recorded start";
  return `"${stale.subtaskTitle}" (${stale.stageName}) — ${age}`;
}
