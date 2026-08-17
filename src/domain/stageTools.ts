/**
 * The built-in tools a stage session is given, and nothing else.
 *
 * Measured 17 Aug 2026 against CLI 2.1.223. A stage session's cached prefix is
 * **31,577 tokens** before it is told anything about the task, and about **15,000
 * of those are schemas for built-in tools a stage never calls** — web search, web
 * fetch, notebook editing and the rest of Claude Code's general-purpose surface.
 * Declaring only the tools stages actually use cuts the prefix by **47%**, to
 * 16,695:
 *
 * | tools declared | prefix tokens |
 * |---|---|
 * | all (default) | 31,577 |
 * | the set below | 16,695 |
 * | six-tool guess (breaks Skill/Agent) | 7,764 |
 * | none at all | 3,511 |
 *
 * ## The list is measured, not guessed — and guessing broke it
 *
 * Every entry is a tool observed in `SubtaskActivity.toolCounts` across 160 real
 * sessions. That matters because the first list written by intuition — Bash, Read,
 * Write, Edit, Glob, Grep — saved more (75%) and would have quietly disabled three
 * things the harness depends on: `Skill`, used in 31% of sessions, is how the
 * protocol skill loads; `Agent`, 7%, is subagent delegation, which `subagentLimits`
 * exists to govern rather than remove; `ToolSearch`, 14%, is how deferred tools are
 * found. A cheaper prefix that silently costs a stage its protocol is not a saving.
 *
 * ## Why removal rather than refusal
 *
 * The same argument `subagentLimits` makes about the Agent tool and the scan runner
 * makes about `--disallowed-tools`: an agent that never had a tool does the work
 * with what it has, where an agent whose call is refused spends turns discovering
 * the wall and working around it. Declaring the set is also a statement of what a
 * stage *may* do, which is the permission gate's posture rather than Claude Code's.
 *
 * ## Why this is a default and not a constant
 *
 * A stage that genuinely needs a tool outside this set — a route that reads a
 * ticket over HTTP, a project on a CLI whose built-in set differs — must not need a
 * new build to get it. `additionalStageTools` widens the set from configuration,
 * exactly as `gatedTools` is configurable, and an operator who empties the setting
 * gets the CLI's own default back rather than a broken stage.
 *
 * Pure and vscode-free.
 */

/**
 * Built-in tools observed in real stage sessions, with the share of sessions that
 * used each. Ordered by use, and kept as data because the comment is the evidence:
 * a future edit that drops one should have to argue with a number.
 */
export const MEASURED_STAGE_TOOLS: readonly { name: string; sessionShare: number }[] = [
  { name: "Bash", sessionShare: 0.89 },
  { name: "Read", sessionShare: 0.73 },
  { name: "Skill", sessionShare: 0.31 },
  { name: "PowerShell", sessionShare: 0.28 },
  { name: "Edit", sessionShare: 0.28 },
  { name: "Grep", sessionShare: 0.2 },
  { name: "Write", sessionShare: 0.19 },
  { name: "ToolSearch", sessionShare: 0.14 },
  { name: "Glob", sessionShare: 0.07 },
  { name: "Agent", sessionShare: 0.07 },
  // Rare but load-bearing: the companion to `Agent` for a delegated run's output.
  // Kept despite 1% because its absence only bites on the sessions that delegate,
  // which are the expensive ones, and a saving measured in tokens must not cost a
  // subagent's result.
  { name: "TaskOutput", sessionShare: 0.01 },
];

/**
 * The tools a stage session declares.
 *
 * MCP tools are deliberately absent: they arrive through `--mcp-config` and are not
 * part of the built-in set, so listing them here would neither add nor remove one.
 */
export function stageTools(additional: readonly string[] = []): string[] {
  const extra = additional.map((tool) => tool.trim()).filter((tool) => tool.length > 0);
  const seen = new Set<string>();
  return [...MEASURED_STAGE_TOOLS.map((tool) => tool.name), ...extra].filter((tool) => {
    const key = tool.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
