/**
 * How long a stage may block waiting for a human to answer `ask_user`.
 *
 * The tool blocks by design: the answer comes back as the tool's *result*, so the
 * agent continues mid-turn keeping everything it had worked out. That economy is the
 * whole reason `ask_user` exists rather than `NEEDS-INFO`, which ends the session and
 * re-runs the subtask.
 *
 * But the CLI has its own timeout on an MCP tool call, and nothing here set it. On the
 * default, a question unanswered for a few minutes fails as a timed-out tool call — and
 * the agent, told nothing useful, proceeds on its own judgement, finishes the turn, and
 * the stage is recorded as done. The failure is silent and it is in the worst direction:
 * a stage that asked precisely because it did not know, answering itself.
 *
 * The default here is deliberately long, because the KPI is one engineer supervising
 * several concurrent tasks. A question waiting an hour is the *designed* case — the
 * operator is meant to be looking at another task — not an edge case. A window short
 * enough to expire while someone is working elsewhere makes `ask_user` useful only when
 * you happen to be watching the task that asked, which is the situation it was built to
 * remove.
 *
 * Set per stage process, like `subagentLimits`, so a chat session the user drives by
 * hand keeps the CLI's defaults.
 */

/** Timeout for a single MCP tool call, in milliseconds. */
export const MCP_TOOL_TIMEOUT_VAR = "MCP_TOOL_TIMEOUT";

/**
 * Timeout for MCP server *startup*, in milliseconds.
 *
 * Raised alongside the tool timeout, but not to the same value: a server that has not
 * connected in a minute is broken, and waiting an hour to discover that would spend the
 * stage's own budget on a stage that cannot run. Startup failing fast is what
 * `mcpReadiness` needs in order to abandon the stage before inference.
 */
export const MCP_STARTUP_TIMEOUT_VAR = "MCP_TIMEOUT";

const STARTUP_TIMEOUT_MS = 60_000;

/**
 * Environment overrides governing how long a stage waits on `ask_user`.
 *
 * Clamped to at least a minute for the same reason `subagentLimits` clamps to one: a
 * zero or negative value would either be read as unset or expire instantly, and both
 * present as the question channel silently not working.
 */
export function askTimeoutEnv(minutes: number): Record<string, string> {
  return {
    [MCP_TOOL_TIMEOUT_VAR]: String(atLeastAMinute(minutes) * 60_000),
    [MCP_STARTUP_TIMEOUT_VAR]: String(STARTUP_TIMEOUT_MS),
  };
}

function atLeastAMinute(minutes: number): number {
  if (!Number.isFinite(minutes)) return 1;
  return Math.max(1, Math.floor(minutes));
}
