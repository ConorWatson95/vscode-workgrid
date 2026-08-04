/**
 * Reduces a project's MCP config to the servers a stage session actually needs.
 *
 * Why this exists: every subtask runs a fresh CLI, and the CLI starts **every**
 * server in the config before it emits its first event. Measured on a real
 * project: nine servers, eight of them local stdio processes that failed, and
 * 182 seconds of sequential connect timeouts — paid again on every subtask of
 * every stage. A build stage does not need seven database servers to compile
 * something.
 *
 * Filtering only ever *removes* servers, which is what makes it safe to do here.
 * The config is read from the repository root precisely so a branch cannot grant
 * itself new tool access; taking servers away cannot violate that, and a stage
 * that is denied a server it needed fails visibly rather than silently gaining
 * something.
 *
 * Pure and vscode-free: the caller does the reading and writing.
 */

export interface McpFilterResult {
  /** The reduced config, ready to write. */
  json: string;
  /** Server names kept, in config order. */
  kept: string[];
  /** Server names removed. */
  dropped: string[];
}

/** The two shapes seen in the wild for the server map. */
const SERVER_KEYS = ["mcpServers", "servers"] as const;

/**
 * Filters `raw` down to `allow`.
 *
 * Returns `undefined` when there is nothing sensible to do — unparseable JSON,
 * no server map, or an empty allow-list (which means "no opinion", not "no
 * servers"). The caller then uses the original config untouched, so a
 * misconfiguration here can never be the reason a stage lost its tools.
 */
export function filterMcpConfig(
  raw: string,
  allow: readonly string[],
): McpFilterResult | undefined {
  const wanted = new Set(
    allow.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0),
  );
  if (wanted.size === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const config = parsed as Record<string, unknown>;
  const key = SERVER_KEYS.find(
    (candidate) =>
      config[candidate] !== null &&
      typeof config[candidate] === "object" &&
      !Array.isArray(config[candidate]),
  );
  if (!key) return undefined;

  const servers = config[key] as Record<string, unknown>;
  const kept: string[] = [];
  const dropped: string[] = [];
  const reduced: Record<string, unknown> = {};

  for (const [name, definition] of Object.entries(servers)) {
    if (wanted.has(name.trim().toLowerCase())) {
      kept.push(name);
      reduced[name] = definition;
    } else {
      dropped.push(name);
    }
  }

  // Nothing matched: the allow-list names servers this project does not have,
  // which is far more likely a typo than an instruction to run with none. Fall
  // back rather than silently stripping every tool from every stage.
  if (kept.length === 0) return undefined;

  // Unknown top-level keys are preserved: this file is the project's, and we
  // understand only one part of it.
  return {
    json: `${JSON.stringify({ ...config, [key]: reduced }, null, 2)}\n`,
    kept,
    dropped,
  };
}
