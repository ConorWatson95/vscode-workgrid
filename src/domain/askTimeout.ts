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
 *
 * **Zero means wait indefinitely**, and it is the setting's most defensible value
 * rather than an escape hatch. The premise of the harness is that a task can be put
 * down: a question raised while the operator is working on another task, or at lunch,
 * or tomorrow morning, is the designed case and not an edge one. Any finite bound makes
 * that a race the operator has to think about, and an operator who has to remember to
 * go back and check a task before a timer expires is doing the supervision the harness
 * exists to remove. The previous default of two hours was chosen against the CLI's own
 * short default and was still, in effect, a reason to feel anxious.
 *
 * Expressed as a very large finite number rather than by omitting the variable, and
 * that distinction is the whole implementation: **absent means the CLI's own default**,
 * which is short — so omitting it to mean "no limit" would produce exactly the failure
 * this module was written to fix, and produce it silently. There is no value meaning
 * unbounded in the CLI's interface, so the harness supplies the largest one that is
 * unambiguously a number.
 *
 * What is *not* claimed: a question does not survive the window. The CLI process
 * belongs to the extension host, so a reload, a VS Code restart or a machine reboot
 * ends the session holding it, and the subtask reverts to pending and runs again. Zero
 * removes the clock, not the process's mortality — an overnight question is safe from
 * the timeout and not from a Windows update.
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
 * The bound used when the setting says "wait indefinitely" — a hundred days.
 *
 * Large enough that nothing reaches it: the session's own process will not survive a
 * hundred days of Windows updates, so the process is the real limit and this number
 * simply stops being the one that bites. Not `Number.MAX_SAFE_INTEGER`, because these
 * values are stringified into an environment variable and read back as an integer by
 * another program, and a number that large is where parsers start disagreeing —
 * an overflow read as zero would expire every question instantly.
 */
export const INDEFINITE_TIMEOUT_MS = 100 * 24 * 60 * 60_000;

/** Whether this configured value means "no limit". */
export function isIndefinite(minutes: number): boolean {
  return Number.isFinite(minutes) && minutes <= 0;
}

/**
 * How long a stage may wait, in ms — the one place the zero convention is resolved, so
 * the environment variable and the server's own idle field cannot disagree about it.
 *
 * Clamped to at least a minute otherwise, for the same reason `subagentLimits` clamps
 * to one: a fractional value would expire instantly, which presents as the question
 * channel silently not working rather than as a misconfiguration.
 */
export function askTimeoutMs(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60_000;
  if (isIndefinite(minutes)) return INDEFINITE_TIMEOUT_MS;
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

/**
 * Environment overrides governing how long a stage waits on `ask_user`.
 *
 * The variable is always set, never omitted — see the note above on why absence is the
 * one thing "unbounded" must not be spelled as.
 */
export function askTimeoutEnv(minutes: number): Record<string, string> {
  return {
    [MCP_TOOL_TIMEOUT_VAR]: String(askTimeoutMs(minutes)),
    [MCP_STARTUP_TIMEOUT_VAR]: String(STARTUP_TIMEOUT_MS),
  };
}
