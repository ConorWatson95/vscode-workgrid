/**
 * Bounds on the fan-out a single stage session may create.
 *
 * The harness owns concurrency at the task level — the whole point is one person
 * supervising several tasks at once — but the CLI has its own idea of how many
 * subagents a session may run, and its default is far larger than any single
 * stage needs. Left alone, one stage spawning a tree of agents does not finish
 * twenty times sooner; it starves the other tasks of the machine and the rate
 * limit they share, and the loss shows up as "everything was slow today" rather
 * than as anything attributable.
 *
 * Expressed as environment variables because that is the only knob the CLI
 * exposes for it, and set per stage process so a chat session the user drives by
 * hand is unaffected.
 */
export interface SubagentLimits {
  /** Subagents one stage session may run at once. */
  concurrency: number;
  /**
   * How many *levels* of subagent may exist below the stage session.
   *
   * Probed on CLI 2.1.223 rather than assumed, because the two readings differ by
   * exactly one and the wrong one silently switches subagents off. At `1` a stage
   * spawns subagents normally and those subagents have no Agent tool at all; at
   * `3` they have it and nesting succeeds. So `1` means "delegation, but no
   * trees", which is the intent — not "no delegation".
   *
   * Enforced by *removing the tool* from the nested session rather than refusing
   * the call. That is the better failure: an agent offered a tool and denied it
   * spends turns rewording the request, while one that never had it simply does
   * the work itself.
   */
  depth: number;
}

export const MAX_CONCURRENT_SUBAGENTS_VAR = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS";
export const MAX_SUBAGENT_SPAWN_DEPTH_VAR = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";

/**
 * Environment overrides for a stage process.
 *
 * Values are floored to whole numbers and to at least one. A zero or negative
 * limit would be read by the CLI as unset — which is the *opposite* of what a
 * user setting it to zero meant — so the cap is clamped rather than passed
 * through, and the one case a reader would misdiagnose never arises.
 */
export function subagentLimitEnv(limits: SubagentLimits): Record<string, string> {
  return {
    [MAX_CONCURRENT_SUBAGENTS_VAR]: String(atLeastOne(limits.concurrency)),
    [MAX_SUBAGENT_SPAWN_DEPTH_VAR]: String(atLeastOne(limits.depth)),
  };
}

function atLeastOne(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}
