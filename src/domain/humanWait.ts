import { SubtaskActivity, Subtask } from "./taskPipeline";

/**
 * Time a stage spent blocked on a human, so it stops being counted as work.
 *
 * `ask_user` is the harness's cheapest way to answer a stage's question: the answer
 * returns as the tool's result, so the session continues mid-turn with everything it
 * had worked out, against a `NEEDS-INFO` that throws the whole subtask away. The
 * side effect is that the operator's thinking time lands *inside* the subtask's
 * `startedAt`/`finishedAt` span, and nothing separated the two.
 *
 * That is not a cosmetic gap, it is a measurement that lies in the direction that
 * matters. The first real latency measurement of a route — 23 stages, 65.4 minutes
 * of wall clock — reported **4% idle**, which said the route was not
 * supervision-bound and sent the optimisation effort at execution instead. But its
 * 32-minute SQL implementation stage had called `ask_user` twice, and however long
 * those two answers took was inside that 32 minutes, recorded as the model working.
 * So the one number the harness exists to move was folded into the one number it
 * cannot.
 *
 * Everything here is pure and vscode-free; `AskUserService` measures the waits and
 * `PipelineRunner` folds them in.
 */

/**
 * Milliseconds between two ISO timestamps, or 0 when they cannot give a duration.
 *
 * Clamped at zero for the reason `stageUsage` clamps: these come from whatever clock
 * wrote them, and a negative wait would silently *reduce* the working time it is
 * subtracted from — making a stage look faster because a clock skewed.
 */
export function waitedMs(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

/**
 * Adds human-wait time to an activity record, immutably.
 *
 * Accumulates rather than replaces: a subtask may ask more than once, and a real one
 * did — two `ask_user` calls in a single 32-minute stage. Returns the input unchanged
 * when there is nothing to add, so a route that never asked anything round-trips
 * without gaining a zero field.
 *
 * Creates an activity record when there was none. A session that asked a question and
 * then died before reporting anything still waited, and that wait is the only thing
 * anyone can learn from it.
 */
export function withHumanWait(
  activity: SubtaskActivity | undefined,
  ms: number,
): SubtaskActivity | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return activity;
  const already = activity?.blockedOnHumanMs ?? 0;
  return { ...(activity ?? {}), blockedOnHumanMs: already + Math.round(ms) };
}

/**
 * What one subtask reports having waited on a human.
 *
 * Zero for a subtask that recorded nothing, which means *unmeasured*, not *no wait* —
 * anything that ran before this existed reports zero. That distinction is why
 * `LatencyTotals` carries the wait separately instead of quietly folding it into the
 * working time: an unrecorded wait inflates the work, and a reader who can see which
 * is which can discount it.
 */
export function humanWaitOf(subtask: Subtask): number {
  const recorded = subtask.activity?.blockedOnHumanMs;
  if (typeof recorded !== "number" || !Number.isFinite(recorded) || recorded < 0) {
    return 0;
  }
  return recorded;
}

/** Total human-wait across a set of subtasks. */
export function humanWaitTotal(subtasks: readonly Subtask[]): number {
  return subtasks.reduce((total, subtask) => total + humanWaitOf(subtask), 0);
}

/**
 * A running tally of human-wait per task, for the service that measures it.
 *
 * A cumulative counter sampled before and after a subtask, rather than a value
 * handed over when a question is answered. The reason is that the wait ends inside
 * `StageSessionRunner.run`, several layers below the code that owns the subtask
 * record — so the runner takes a reading either side and keeps the difference,
 * exactly as it snapshots the worktree list around a stage that may create one.
 *
 * A question answered while no subtask is running is still counted. It cannot be
 * attributed, and the alternative — discarding it — would under-report supervision,
 * which is the failure this whole module exists to correct.
 */
export class HumanWaitTally {
  private readonly totals = new Map<string, number>();

  /** Records a completed wait against a task. */
  add(taskId: string, ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.totals.set(taskId, (this.totals.get(taskId) ?? 0) + Math.round(ms));
  }

  /** Cumulative wait for a task since this tally began. */
  total(taskId: string): number {
    return this.totals.get(taskId) ?? 0;
  }

  /** Forgets a task, when its questions and inbox are torn down. */
  forget(taskId: string): void {
    this.totals.delete(taskId);
  }
}
