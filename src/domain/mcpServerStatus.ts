/**
 * What the CLI reported about MCP startup, in domain terms.
 *
 * Lives here rather than beside the stream parser because the readiness decision
 * is a domain rule and must not import the agent layer to learn the shape of its
 * own input.
 */

/** An MCP server the CLI reported at startup, with how it ended up. */
export interface McpServerStatus {
  name: string;
  /** The CLI's own word, e.g. "connected", "failed". */
  status: string;
}

/**
 * A `--mcp-config` entry the CLI rejected during startup validation, reported on
 * the init event. Distinct from a server that failed to connect: this one never
 * became a server at all, so it appears in no status list.
 */
export interface McpServerError {
  name: string;
  message: string;
}
