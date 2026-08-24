/**
 * What the stage timeout is actually bounding.
 *
 * `stageTimeoutMinutes` exists to stop a hung CLI stalling a route forever, and its
 * own description says so. It was implemented as a flat wall-clock timer over the
 * whole subtask, which is a different quantity: a stage blocked on `ask_user` is
 * waiting for a person, and the harness measures that wait already
 * (`domain/humanWait.ts`).
 *
 * So the shorter of the two timeouts always won. With the defaults —
 * `stageTimeoutMinutes` 45, `askTimeoutMinutes` 120 — a question could never wait
 * longer than 45 minutes whatever the ask timeout said, and when the cap fired the
 * subtask was recorded as `timed out after 45 minute(s)`: a hung CLI. That is the
 * misattribution `transientFailure` exists to prevent, arriving by another route —
 * a wait that was never the stage's doing, charged to the stage.
 *
 * Subtracting the wait is what makes the two settings independent, and it is what
 * lets the ask timeout be the only thing bounding a question.
 */

/** What to do when the stage timer fires. */
export type StageTimeoutDecision =
  | { kind: "expired" }
  /** Re-arm for this many ms, because the elapsed time was spent waiting on a human. */
  | { kind: "rearm"; afterMs: number };

/**
 * The floor on a re-arm.
 *
 * A re-arm computed from a wait that is still open would otherwise be near zero and
 * fire again immediately, spinning a timer for as long as the question is unanswered.
 * The cost of the floor is that a stage may overshoot its working budget by up to this
 * much, which is the right trade against a busy loop.
 */
const MIN_REARM_MS = 30_000;

/**
 * Decides whether a subtask has genuinely used its working budget.
 *
 * `blockedMs` is the human wait accumulated *during this subtask* — the difference
 * between a reading taken as the session started and one taken now, the same
 * before-and-after sampling `UsageTotals.blockedOnHumanMs` is built from. It must
 * include a wait still in flight, since a stage blocked right now is the whole case
 * this exists for.
 *
 * Two rules:
 *
 * - **Unmeasured wait is working time.** A gate that cannot report a wait passes
 *   `undefined`, and the timer then behaves exactly as it did before — the rule
 *   `stageUsage` and `stageProductivity` already follow. Defaulting the other way would
 *   switch the hung-CLI bound off wherever the ask channel is unavailable, which is
 *   precisely where a hang cannot be a question.
 * - **The wait is clamped to the elapsed time.** The tally is per *task* and survives a
 *   subtask, so a reading that outruns the session's own clock means the sampling
 *   slipped; crediting more wait than time has passed would make the budget unbounded.
 */
export function stageTimeoutDecision(
  elapsedMs: number,
  budgetMs: number,
  blockedMs: number | undefined,
): StageTimeoutDecision {
  const blocked = Math.min(Math.max(blockedMs ?? 0, 0), Math.max(elapsedMs, 0));
  const working = Math.max(elapsedMs, 0) - blocked;
  if (working >= budgetMs) return { kind: "expired" };
  return { kind: "rearm", afterMs: Math.max(budgetMs - working, MIN_REARM_MS) };
}
