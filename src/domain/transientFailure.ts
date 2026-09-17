/**
 * Telling "the API was overloaded" apart from "the stage got the work wrong".
 *
 * Every failing path in the runner recorded the same thing: `finishSubtask(...,
 * "failed")`, which fails the whole stage, and `nextAction` then reports `blocked`
 * with no way back except `revertToStage` — which discards the stage and everything
 * after it. So a 529 cost exactly what a wrong approach costs. On a correction run
 * that is the worse half: `correctStage` exists because a cold re-run cost $12.48 and
 * 44 minutes to change a type, and a transport error was throwing that saving away for
 * a reason that had nothing to do with the work.
 *
 * The distinction is not a nicety. A stage that failed on its own account has told you
 * something and a human should read it; a stage whose session died mid-turn on someone
 * else's capacity has told you nothing at all, and re-running it is the entire remedy.
 */

/** Where the blame for a failed session lies. */
export type FailureOrigin =
  /** Somebody else's capacity, or the network. Nothing about the stage is wrong. */
  | "infrastructure"
  /**
   * The plan's own limit. Nothing about the stage is wrong either, but no amount of
   * backoff reaches the other side of it, so it is neither retried nor blamed.
   */
  | "capacity"
  /** The stage, the prompt, the tools, the CLI's own limits. A human should read it. */
  | "stage";

/**
 * Phrases that only ever come from the transport.
 *
 * Deliberately keyed on the shapes an API error actually has — a status code beside a
 * recognised name, or a named network condition — rather than on any occurrence of a
 * word like "overloaded", which a stage could legitimately write about a database.
 * The reason string this reads is the CLI's own account of the failure
 * (`result`, then subtype, then stderr), never the agent's report, so the vocabulary
 * can be this small.
 */
const INFRASTRUCTURE = [
  /\b529\b/,
  /\boverloaded\b/i,
  /\b(502|503|504)\b/,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway time-?out\b/i,
  /\binternal server error\b/i,
  /\bupstream (connect|request) (error|timeout)\b/i,
  /\b(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN)\b/,
  /\bsocket hang ?up\b/i,
  /\bfetch failed\b/i,
  /\bpremature close\b/i,
  // A short-window rate limit clears on its own, which is what a retry is for.
  /\b429\b/,
  /\brate ?limit/i,
];

/**
 * Phrases that look transient and are not, checked first.
 *
 * A plan or credit limit arrives wearing 429's clothes and no amount of backoff reaches
 * the other side of it — retrying would spend the budget discovering that, then report
 * the wrong reason. So it is excluded from the retry, which was always right; what was
 * wrong for as long as this file has existed is that it then fell through to `"stage"`
 * and *failed* the stage, whose only remedy is `revertToStage` — discarding the stage
 * and everything after it. Running out of plan capacity therefore cost strictly more
 * than a 529, which is held. This module's own opening paragraph is the argument
 * against that: a session that died on somebody else's capacity has told you nothing
 * about the work, and a plan limit is exactly that with a longer wait attached.
 *
 * Its own origin rather than a flag on the existing one, because the disposition
 * differs in both directions: no retry, and no blame either.
 */
const CAPACITY = [
  /\busage limit\b/i,
  /\bcredit balance\b/i,
  /\bquota\b/i,
];

/**
 * Phrases that look transient and are genuinely the stage's, checked next.
 *
 * An authentication failure is the one shape that resembles a capacity limit and must
 * not be held quietly waiting for a window to reset: nothing resets, and a human has
 * to go and fix a key. Holding it would present a permanent misconfiguration as a wait.
 */
const NOT_TRANSIENT = [
  /\b(401|403)\b/,
  /\bunauthorized\b/i,
  /\binvalid api key\b/i,
];

/**
 * Who a failed session's reason blames.
 *
 * Anything unrecognised is the stage's, which is the safe direction: an unclassified
 * failure keeps exactly the behaviour it has always had, and only a reason positively
 * identified as the transport's earns a retry.
 */
export function classifyFailure(reason: string | undefined): FailureOrigin {
  const text = reason?.trim();
  if (!text) return "stage";
  // Capacity first: a plan limit routinely arrives carrying 429 as well, and read the
  // other way round it would be retried until the budget was spent proving it could not
  // be.
  if (CAPACITY.some((pattern) => pattern.test(text))) return "capacity";
  if (NOT_TRANSIENT.some((pattern) => pattern.test(text))) return "stage";
  return INFRASTRUCTURE.some((pattern) => pattern.test(text))
    ? "infrastructure"
    : "stage";
}

/** Whether a failed session is worth simply running again. */
export function isTransientFailure(reason: string | undefined): boolean {
  return classifyFailure(reason) === "infrastructure";
}

/**
 * Whether a failed session ran out of plan capacity.
 *
 * Held rather than retried, and held rather than failed. The route needs another
 * advance once the window resets, which is the same thing an exhausted retry budget
 * needs — so it reuses that path exactly, minus the retrying.
 */
export function isCapacityFailure(reason: string | undefined): boolean {
  return classifyFailure(reason) === "capacity";
}

/** How many times a transient failure is re-run before a human is told. */
export const DEFAULT_TRANSIENT_ATTEMPTS = 3;

/** The longest a retry ever waits, so a wedged route is not silent for an hour. */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * How long to wait before attempt `attempt` (1-based, so the first retry is 1).
 *
 * Exponential from 20s, jittered, capped. Jittered because several tasks advancing
 * at once all fail on the same overload and would otherwise retry in lockstep,
 * arriving together at exactly the moment capacity is thinnest. `random` is a
 * parameter for the reason every clock here is injected: nothing pure calls out.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(20_000 * Math.pow(4, Math.max(0, attempt - 1)), MAX_BACKOFF_MS);
  // ±20%, so a burst of tasks spreads out rather than retrying in lockstep.
  return Math.round(base * (0.8 + 0.4 * random()));
}
