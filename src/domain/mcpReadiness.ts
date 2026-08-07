import { McpServerError, McpServerStatus } from "./mcpServerStatus";

/**
 * Whether a stage's declared MCP servers actually came up.
 *
 * The CLI connects `--mcp-config` servers before the first turn and reports both
 * the resulting statuses and any config entries it rejected at startup. Reading
 * that is the difference between a stage failing with "the qube-jira server did
 * not connect" and a stage cheerfully proceeding without the tools it was given,
 * inventing the ticket contents and reporting done — which is the same class of
 * silent success as a skipped plan step, and just as expensive to find later.
 *
 * Only *required* servers gate the stage. A project config may name servers that
 * are irrelevant to this route, and failing every stage on an unrelated broken
 * entry is how a safety net gets switched off.
 */
export interface McpReadiness {
  ok: boolean;
  /** Required servers the init event never mentioned. */
  missing: string[];
  /** Required servers that were mentioned but did not connect. */
  failed: string[];
  /** One sentence naming what is wrong, for the stage's failure reason. */
  reason?: string;
}

/**
 * Names are compared case- and whitespace-insensitively. They are config keys
 * copied between a route file and an MCP config by hand, and a casing mismatch
 * would present as "server missing" — indistinguishable from the server being
 * genuinely absent, which is the one diagnosis that sends you to the wrong place.
 */
function key(name: string): string {
  return name.trim().toLowerCase();
}

export function assessMcpReadiness(
  required: readonly string[],
  servers: readonly McpServerStatus[] | undefined,
  errors: readonly McpServerError[] | undefined,
): McpReadiness {
  const wanted = required.map((name) => name.trim()).filter((name) => name.length > 0);
  if (wanted.length === 0) return { ok: true, missing: [], failed: [] };

  const byName = new Map((servers ?? []).map((server) => [key(server.name), server]));
  const errorByName = new Map((errors ?? []).map((error) => [key(error.name), error]));

  const missing: string[] = [];
  const failed: string[] = [];
  const details: string[] = [];

  for (const name of wanted) {
    const error = errorByName.get(key(name));
    const server = byName.get(key(name));
    // A rejected config entry outranks a status: the entry never became a server,
    // so its absence from the list is a consequence, not a second problem.
    if (error) {
      failed.push(name);
      details.push(`${name} (${error.message})`);
      continue;
    }
    if (!server) {
      missing.push(name);
      continue;
    }
    if (server.status !== "connected") {
      failed.push(name);
      details.push(`${name} (${server.status})`);
    }
  }

  if (missing.length === 0 && failed.length === 0) {
    return { ok: true, missing: [], failed: [] };
  }

  const parts: string[] = [];
  if (failed.length > 0) parts.push(`did not connect: ${details.join(", ")}`);
  if (missing.length > 0) parts.push(`not configured: ${missing.join(", ")}`);
  return {
    ok: false,
    missing,
    failed,
    reason: `required MCP server(s) unavailable — ${parts.join("; ")}`,
  };
}
