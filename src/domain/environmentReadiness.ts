/**
 * A check that could not run yet, because the environment it inspects has not caught up.
 *
 * Found on NMGB-2822, 8 Oct 2026. The DEV sign-off's browser checks ran four minutes
 * after the merge into DEV, while CI/CD was still building it, and reported that the
 * CRM page "contains Excluded From Campaigns, which it must not". True of the site, and
 * nothing to do with the work: the change was on DEV in git and simply not yet served.
 * The stage failed, and a failed stage's account is that the work is wrong.
 *
 * Only the check can know whether its environment is ready, so it says so with a line
 * of its own: `NOT-READY: <why>`, and no checks run. The harness then waits and asks
 * again, and when the wait runs out it holds the stage with that sentence rather than
 * failing it. The same shape as a transport failure: nothing about the stage has been
 * judged, so nothing is recorded against it.
 *
 * The marker is read from a **process's** output, not a model's reply, which is why it
 * is not built with `markerLine` — a script prints plain text, and admitting markdown
 * lead-ins here would only widen what can be mistaken for it.
 */

const NOT_READY_LINE = /^[ \t]*NOT-READY:[ \t]*(\S.*?)[ \t\r]*$/gm;

/** How long a stage's check is re-asked before the stage is held. */
export const DEFAULT_ENVIRONMENT_WAIT_MINUTES = 20;

/** Between asks. A deploy takes minutes, and each ask is a cheap probe, not a run. */
export const ENVIRONMENT_POLL_MS = 60_000;

/**
 * The reason a check gave for not running, or undefined when it did not say.
 *
 * The **last** such line, since a probe may report progress before its conclusion.
 */
export function parseNotReady(output: string): string | undefined {
  let found: string | undefined;
  for (const match of output.matchAll(NOT_READY_LINE)) found = match[1];
  return found && found.length > 0 ? found : undefined;
}

/**
 * The hold placed when the wait runs out.
 *
 * Names its remedy, because the obvious move on a stopped stage is a re-run and that
 * would pay for the session again to learn nothing: the session's work is done, and
 * only the check is outstanding.
 */
export function notReadyHoldReason(reason: string, waitedMinutes: number): string {
  const waited =
    waitedMinutes > 0
      ? `still not ready after ${waitedMinutes} minute${waitedMinutes === 1 ? "" : "s"}`
      : "not ready";
  return (
    `The environment this stage's check inspects is ${waited}: ${reason}\n\n` +
    "Nothing about the stage is wrong and no check ran. Use Re-run Check once it " +
    "has caught up."
  );
}

/** Whether a hold was placed by `notReadyHoldReason`, so a passing re-run may clear it. */
export function isNotReadyHold(reason: string): boolean {
  return reason.startsWith("The environment this stage's check inspects is ");
}
