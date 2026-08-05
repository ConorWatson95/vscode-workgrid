import { SessionTokenTotals, Subtask, TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * Adds up what a stage or a route actually spent.
 *
 * Every number here is recorded per subtask, because a subtask is a session and a
 * session is the only thing the CLI reports totals for. Summing them is therefore
 * the only way to get a figure for a stage — and it is safe to sum precisely
 * because each subtask runs in a *fresh* session, so no two of them include the
 * same turn. Were subtasks to share a session, `costUsd` being cumulative would
 * make this count the earlier ones repeatedly.
 *
 * Pure and vscode-free.
 */

export interface UsageTotals {
  costUsd: number;
  tokens: SessionTokenTotals;
  /**
   * Summed time inside agent sessions, in milliseconds.
   *
   * Deliberately not "first started to last finished": a route sits at an approval
   * gate for as long as it takes someone to read it, and a wall-clock span that
   * includes an overnight wait says nothing about whether a stage got faster. This
   * is the part a change to the harness can actually move.
   */
  elapsedMs: number;
  /** Subtasks that ran and reported cost or tokens. */
  measured: number;
  /**
   * Subtasks that ran and reported neither.
   *
   * Carried alongside the totals rather than ignored, because a partial total
   * presented as a complete one is worse than no total: it invites a comparison
   * between two runs that measured different numbers of subtasks. Anything run
   * before this was recorded falls in here, as does a session that died before it
   * reached a result.
   */
  unmeasured: number;
}

const NO_TOKENS: SessionTokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
};

function emptyTotals(): UsageTotals {
  return { costUsd: 0, tokens: { ...NO_TOKENS }, elapsedMs: 0, measured: 0, unmeasured: 0 };
}

/**
 * True when a subtask got as far as running, so its absence of numbers is worth
 * reporting. A pending subtask is not unmeasured — it has not happened yet, and
 * counting it would make every route look half-instrumented before it starts.
 */
function hasRun(subtask: Subtask): boolean {
  return (
    subtask.status === "done" ||
    subtask.status === "failed" ||
    subtask.startedAt !== undefined ||
    subtask.activity !== undefined
  );
}

/** Milliseconds a subtask spent in its session, or 0 when it cannot be told. */
function elapsedOf(subtask: Subtask): number {
  if (!subtask.startedAt || !subtask.finishedAt) return 0;
  const from = Date.parse(subtask.startedAt);
  const to = Date.parse(subtask.finishedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  // Clamped: stored timestamps come from whatever clock wrote them, and a
  // negative duration would quietly reduce the total it was added to.
  return Math.max(0, to - from);
}

export function subtasksUsage(subtasks: readonly Subtask[]): UsageTotals {
  const totals = emptyTotals();
  for (const subtask of subtasks) {
    if (!hasRun(subtask)) continue;
    totals.elapsedMs += elapsedOf(subtask);

    const activity = subtask.activity;
    const cost = activity?.costUsd;
    const tokens = activity?.tokens;
    if (cost === undefined && !tokens) {
      totals.unmeasured += 1;
      continue;
    }
    totals.measured += 1;
    if (cost !== undefined) totals.costUsd += cost;
    if (tokens) {
      totals.tokens.input += tokens.input;
      totals.tokens.output += tokens.output;
      totals.tokens.cacheRead += tokens.cacheRead;
      totals.tokens.cacheCreation += tokens.cacheCreation;
    }
  }
  return totals;
}

export function stageUsage(stage: TaskStage): UsageTotals {
  return subtasksUsage(stage.subtasks);
}

/** Every stage of a route, for the figure a comparison is actually made on. */
export function pipelineUsage(pipeline: TaskPipeline): UsageTotals {
  return subtasksUsage(pipeline.stages.flatMap((stage) => stage.subtasks));
}

/** True when there is a number worth showing. */
export function hasUsage(totals: UsageTotals): boolean {
  return totals.measured > 0 || totals.unmeasured > 0 || totals.elapsedMs > 0;
}
