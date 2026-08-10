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
  /**
   * Distinct models that actually ran, as the CLI resolved them.
   *
   * Recorded because a stage's requested model is not proof of what executed: an
   * organisational policy that disallows one substitutes the parent's without
   * failing. Two entries here on a stage that asked for one is the signal that a
   * cost comparison is measuring a fallback rather than the choice being tested.
   */
  models: string[];
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
  return {
    costUsd: 0,
    tokens: { ...NO_TOKENS },
    elapsedMs: 0,
    measured: 0,
    unmeasured: 0,
    models: [],
  };
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
  const models = new Set<string>();
  for (const subtask of subtasks) {
    if (!hasRun(subtask)) continue;
    totals.elapsedMs += elapsedOf(subtask);
    // What ran, not what was asked for. A model an org policy disallows falls
    // back silently, and two runs compared on the requested name would then be
    // two runs of the same model reported as a comparison between two.
    if (subtask.activity?.actualModel) models.add(subtask.activity.actualModel);

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
  totals.models = [...models].sort();
  return totals;
}

export function stageUsage(stage: TaskStage): UsageTotals {
  return subtasksUsage(stage.subtasks);
}

/**
 * Every stage of a route, **including runs that were thrown away**.
 *
 * The discarded half is the whole reason this is not just a sum over the stages. A
 * re-opened stage's `activity` is cleared, so a route sent back six times reported
 * the cost of its last attempt — the number looked calm while the operator was
 * paying for the same expensive stage five times over. What a route costs is what
 * was spent on it, not what survives on it.
 */
export function pipelineUsage(pipeline: TaskPipeline): UsageTotals {
  const live = subtasksUsage(pipeline.stages.flatMap((stage) => stage.subtasks));
  return addDiscarded(live, pipeline);
}

/** What is currently on the stages, ignoring anything discarded. */
export function survivingUsage(pipeline: TaskPipeline): UsageTotals {
  return subtasksUsage(pipeline.stages.flatMap((stage) => stage.subtasks));
}

/** What re-runs threw away, on its own. Empty totals when nothing was discarded. */
export function discardedUsage(pipeline: TaskPipeline): UsageTotals {
  const totals = emptyTotals();
  for (const run of pipeline.discarded ?? []) {
    totals.costUsd += run.costUsd ?? 0;
    totals.elapsedMs += run.elapsedMs ?? 0;
    totals.measured += run.sessions;
    if (run.tokens) {
      totals.tokens.input += run.tokens.input;
      totals.tokens.output += run.tokens.output;
      totals.tokens.cacheRead += run.tokens.cacheRead;
      totals.tokens.cacheCreation += run.tokens.cacheCreation;
    }
  }
  return totals;
}

function addDiscarded(live: UsageTotals, pipeline: TaskPipeline): UsageTotals {
  const gone = discardedUsage(pipeline);
  if (!hasUsage(gone)) return live;
  return {
    costUsd: live.costUsd + gone.costUsd,
    elapsedMs: live.elapsedMs + gone.elapsedMs,
    measured: live.measured + gone.measured,
    unmeasured: live.unmeasured + gone.unmeasured,
    models: live.models,
    tokens: {
      input: live.tokens.input + gone.tokens.input,
      output: live.tokens.output + gone.tokens.output,
      cacheRead: live.tokens.cacheRead + gone.tokens.cacheRead,
      cacheCreation: live.tokens.cacheCreation + gone.tokens.cacheCreation,
    },
  };
}

/**
 * How many times each stage has been re-run, worst first.
 *
 * The shape of the churn rather than its total: one costly stage re-run five times
 * and a route that churns everywhere sum to the same money and need opposite fixes.
 */
export function rerunCounts(
  pipeline: TaskPipeline,
): { stageId: string; stageName: string; times: number; costUsd: number }[] {
  const byStage = new Map<string, { stageName: string; times: number; costUsd: number }>();
  for (const run of pipeline.discarded ?? []) {
    const entry = byStage.get(run.stageId) ?? {
      stageName: run.stageName,
      times: 0,
      costUsd: 0,
    };
    entry.times += 1;
    entry.costUsd += run.costUsd ?? 0;
    byStage.set(run.stageId, entry);
  }
  return [...byStage.entries()]
    .map(([stageId, entry]) => ({ stageId, ...entry }))
    .sort((a, b) => b.costUsd - a.costUsd || b.times - a.times);
}

/** True when there is a number worth showing. */
export function hasUsage(totals: UsageTotals): boolean {
  return totals.measured > 0 || totals.unmeasured > 0 || totals.elapsedMs > 0;
}
