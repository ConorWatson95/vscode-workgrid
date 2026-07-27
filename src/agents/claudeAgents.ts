import { execFile } from "node:child_process";
import { Logger } from "../logging/logger";

/**
 * A Claude session the CLI reports as currently live, from `claude agents --json`.
 * These may be sessions we spawned, sessions left over from a previous extension
 * host, terminal-mode sessions, or the user's own interactive sessions.
 */
export interface LiveAgentSession {
  pid: number;
  cwd: string;
  /** "interactive" for a TTY session, "background" for a dispatched one. */
  kind: string;
  /** Epoch milliseconds. */
  startedAt: number;
  sessionId: string;
  /** Human-readable label the CLI assigns, e.g. "vscode-workgrid-d1". */
  name: string;
}

/**
 * Parses `claude agents --json` output. Defensive about leading noise (update
 * notices, deprecation warnings) by slicing to the outermost JSON array, and
 * drops entries missing the fields we key on rather than trusting the shape.
 */
export function parseAgentsJson(stdout: string): LiveAgentSession[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const sessions: LiveAgentSession[] = [];
  for (const entry of raw) {
    const e = entry as Partial<LiveAgentSession>;
    // sessionId and cwd are the reuse key; without both the entry is useless.
    if (typeof e.sessionId !== "string" || typeof e.cwd !== "string") continue;
    sessions.push({
      pid: typeof e.pid === "number" ? e.pid : -1,
      cwd: e.cwd,
      kind: typeof e.kind === "string" ? e.kind : "unknown",
      startedAt: typeof e.startedAt === "number" ? e.startedAt : 0,
      sessionId: e.sessionId,
      name: typeof e.name === "string" ? e.name : e.sessionId,
    });
  }
  return sessions;
}

/**
 * Canonical form for comparing working directories. The CLI reports drive
 * letters inconsistently (`c:\Dev` and `C:\Dev` both occur in one listing), so
 * compare case-insensitively with normalised separators and no trailing slash.
 */
export function normalizeWorktreePath(p: string): string {
  return p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * Live sessions whose cwd is exactly `worktreePath`.
 *
 * Deliberately an exact match rather than the CLI's `--cwd` filter: that filter
 * matches descendants too, so querying a repo root would sweep in sessions from
 * every worktree nested beneath it. Task worktrees are siblings today, but the
 * `worktreeParentDir` setting can place them anywhere.
 */
export function sessionsForWorktree(
  sessions: LiveAgentSession[],
  worktreePath: string,
): LiveAgentSession[] {
  const target = normalizeWorktreePath(worktreePath);
  return sessions.filter((s) => normalizeWorktreePath(s.cwd) === target);
}

/**
 * Queries the CLI for all live sessions. Resolves to an empty array on any
 * failure — this is advisory information, so it must never block starting a
 * session.
 */
export function queryLiveSessions(
  command: string,
  logger: Logger,
): Promise<LiveAgentSession[]> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["agents", "--json"],
      // Opening a chat waits on this, so the timeout bounds how long a click can
      // appear to do nothing. The query is advisory and typically well under a
      // second; failing fast and starting a session beats a long stall.
      { windowsHide: true, timeout: 5_000, shell: process.platform === "win32" },
      (error, stdout) => {
        if (error) {
          logger.debug(`claude agents --json failed: ${error.message}`);
          resolve([]);
          return;
        }
        resolve(parseAgentsJson(stdout));
      },
    );
  });
}
