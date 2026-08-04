/**
 * Builds the CLI argument list for a headless Claude session.
 *
 * Extracted from the session class so the argument list — the part that decides
 * which MCP servers load, which directories are reachable and how permissions
 * behave — is unit-tested rather than inferred from a running process.
 *
 * Pure and vscode-free.
 */

export interface CliArgsInput {
  /** Session id to create, used when not resuming. */
  sessionId: string;
  resumeSessionId?: string;
  permissionMode: string;
  model?: string;
  addDirs?: string[];
  /**
   * Path to an MCP server config to load explicitly.
   *
   * A git worktree is a directory the CLI has never seen, so a project-scoped
   * `.mcp.json` sitting in it has not been approved: `enabledMcpjsonServers`
   * stays empty and none of its servers start. Non-interactive sessions skip the
   * trust *dialog*, which is not the same as granting trust, and a headless
   * stage session has nobody to answer a prompt anyway. Passing the config
   * explicitly is what actually loads the servers.
   */
  mcpConfigPath?: string;
  /**
   * Extra settings file layered over the user's own, used to install the
   * permission gate hook.
   *
   * A file the extension owns, never the user's `.claude/settings.local.json`:
   * the hook is machinery for one run and must not accumulate in a file they
   * maintain. It adds no permissions, so it cannot widen what the agent may do.
   */
  settingsPath?: string;
  /**
   * Load **only** `mcpConfigPath`, ignoring every other source of MCP servers.
   *
   * Needed because `--mcp-config` on its own *adds* servers: the worktree
   * contains the project's own tracked `.mcp.json`, and the copied
   * `.claude/settings.local.json` is what approves it — so passing a reduced
   * config alongside those simply loaded both, and a stage asked to run one
   * server still started nine.
   *
   * Off unless a caller has deliberately narrowed the set, because it also
   * discards the user's own user-scope servers, which nobody asked for.
   */
  strictMcpConfig?: boolean;
  /**
   * True when the process is spawned through a shell (Windows), in which case
   * arguments carrying paths have to be quoted or a space ends the argument.
   */
  useShell?: boolean;
}

/**
 * Quotes a value that may contain spaces, but only when a shell will re-parse
 * the command line. Quoting unconditionally would make the quotes part of the
 * path when the argv is passed directly.
 */
function quoteForShell(value: string, useShell: boolean | undefined): string {
  if (!useShell) return value;
  // Already quoted, or nothing that needs it.
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Resolves the configured MCP config to an absolute path, or undefined when
 * there is nothing usable to pass.
 *
 * Resolved against the **repository root** rather than the worktree: MCP servers
 * grant tool access, so letting a branch point this at its own file would let it
 * hand itself new capabilities — the same reasoning that keeps review rules at
 * the root. A missing file yields undefined rather than a flag pointing at
 * nothing, since the CLI would reject that and take the whole session with it.
 */
export function resolveMcpConfigPath(
  repositoryRoot: string,
  configured: string,
  exists: (path: string) => boolean,
): string | undefined {
  const trimmed = configured.trim();
  if (trimmed.length === 0) return undefined;

  const normalised = trimmed.replace(/\\/g, "/");
  if (/^([a-zA-Z]:\/|\/)/.test(normalised)) {
    return exists(normalised) ? normalised : undefined;
  }

  // Strip "./" segments only — a leading dot is part of the filename in the
  // common case (".mcp.json"), so a greedy strip would look for "mcp.json".
  let relative = normalised;
  while (relative.startsWith("./")) relative = relative.slice(2);

  // Refuse to walk above the root: the point of resolving here is that a branch
  // cannot choose which MCP servers it gets.
  if (relative.split("/").includes("..")) return undefined;

  const root = repositoryRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const resolved = `${root}/${relative}`;
  return exists(resolved) ? resolved : undefined;
}

export function buildCliArgs(input: CliArgsInput): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Resume the existing session, or create one with a known id.
    ...(input.resumeSessionId
      ? ["--resume", input.resumeSessionId]
      : ["--session-id", input.sessionId]),
    "--permission-mode",
    input.permissionMode,
  ];

  if (input.model && input.model.trim().length > 0) {
    args.push("--model", input.model.trim());
  }

  for (const dir of input.addDirs ?? []) {
    if (dir.trim().length === 0) continue;
    args.push("--add-dir", quoteForShell(dir, input.useShell));
  }

  // Before --mcp-config, which must stay last.
  if (input.settingsPath && input.settingsPath.trim().length > 0) {
    args.push("--settings", quoteForShell(input.settingsPath.trim(), input.useShell));
  }

  // Only when the caller has narrowed the server set on purpose. Without it
  // `--mcp-config` merely *adds*, so a reduced config sits alongside the
  // worktree's own approved `.mcp.json` and every server starts anyway. A flag,
  // so it can precede the variadic --mcp-config safely.
  if (input.strictMcpConfig && input.mcpConfigPath?.trim()) {
    args.push("--strict-mcp-config");
  }

  // Not --strict-mcp-config by default: plain `--mcp-config` adds the project's
  // servers rather than replacing whatever the user has at user scope.
  //
  // MUST stay last. `--mcp-config` is variadic (it accepts several
  // space-separated configs), so it swallows any following non-flag argument —
  // a positional prompt after it is read as a second config path and the CLI
  // dies with "MCP config file not found". Safe here only because the prompt is
  // written to stdin, never passed as an argument.
  if (input.mcpConfigPath && input.mcpConfigPath.trim().length > 0) {
    args.push("--mcp-config", quoteForShell(input.mcpConfigPath.trim(), input.useShell));
  }

  return args;
}
