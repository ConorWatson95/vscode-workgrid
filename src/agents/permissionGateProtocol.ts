/**
 * The file protocol between a blocking `PreToolUse` hook and the extension.
 *
 * Why a hook at all: a headless stage session has nobody to approve anything, so
 * anything not already covered by `permissions.allow` is denied outright. The
 * agent then rewords the same call several times, works around it, or asks a
 * question that reads like a briefing problem — and the stage has to be re-run
 * once a rule is added.
 *
 * A `PreToolUse` command hook can hold the CLI open while a human decides, then
 * answer `allow` or `deny`, and the agent carries on **mid-turn**. Measured: a
 * hook blocked for 282 seconds and the run then completed with no denials.
 *
 * Two mechanisms that look better are not available, and both were tested:
 *
 * - `can_use_tool` is a real control request, but the CLI only ever emits it down
 *   its own bridge channel. Advertising the capability over stdin changes nothing.
 * - The `PermissionRequest` hook does not fire in print mode. There is no prompt
 *   surface headlessly, so there is no request to hook — the call is simply
 *   denied. Returning `permissionDecision: "ask"` from `PreToolUse` does not
 *   raise one either; an unresolved ask becomes a denial.
 *
 * So `PreToolUse` + `allow`/`deny` is the whole mechanism, and it fires for
 * **every** tool call. That is the design constraint this module exists to
 * manage: the gate must stay out of the way by default and hold only the calls a
 * human actually needs to see. Emitting nothing falls through to the CLI's own
 * classifier, which is what keeps safe reads fast.
 *
 * Pure and vscode-free.
 */

/** What the extension tells a waiting hook to do. */
export type GateDecision =
  /** Let the call run, without needing a persisted rule. */
  | "allow"
  /** Refuse it, and tell the agent why. */
  | "deny"
  /**
   * Decline to intervene: emit nothing and let the CLI's own permission layer
   * decide. The default, and the reason a gate on every tool call is tolerable.
   */
  | "pass";

/** A tool call parked by the hook, waiting on a human. */
export interface GateRequest {
  /** Identifies the request file, so a decision can be routed back to it. */
  id: string;
  sessionId?: string;
  toolName: string;
  /** The tool's raw arguments, as the CLI passed them. */
  toolInput: Record<string, unknown>;
  cwd?: string;
  permissionMode?: string;
}

/** The hook's stdin payload, as far as we rely on it. */
interface HookPayload {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
  permission_mode?: unknown;
  hook_event_name?: unknown;
}

/**
 * Reads a request file written by the gate script.
 *
 * Tolerant on purpose: a payload shape that drifts must not wedge a stage. An
 * unreadable request yields undefined, and the service treats that as `pass`.
 */
export function parseGateRequest(
  id: string,
  text: string,
): GateRequest | undefined {
  let raw: HookPayload;
  try {
    raw = JSON.parse(text) as HookPayload;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  const toolName = typeof raw.tool_name === "string" ? raw.tool_name.trim() : "";
  if (!toolName) return undefined;

  return {
    id,
    sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
    toolName,
    toolInput:
      raw.tool_input && typeof raw.tool_input === "object"
        ? (raw.tool_input as Record<string, unknown>)
        : {},
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    permissionMode:
      typeof raw.permission_mode === "string" ? raw.permission_mode : undefined,
  };
}

/**
 * The argument worth showing a human, and worth deriving a rule from.
 *
 * Command tools carry `command`; file tools carry a path. Falls back to the
 * whole input so a tool we have never seen still renders something truthful
 * rather than an empty row.
 */
export function describeGateRequest(request: GateRequest): string {
  const input = request.toolInput;
  for (const key of ["command", "file_path", "path", "pattern", "url", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const rendered = JSON.stringify(input);
  return rendered === "{}" ? request.toolName : rendered.slice(0, 300);
}

/**
 * Groups a call with its own retries.
 *
 * The agent rewords a refused command rather than repeating it, so an exact
 * match would treat every attempt as new and ask the user five times for one
 * capability. Keyed on tool plus the *first* token of the argument, which is the
 * executable or the directory — stable across rewordings.
 */
export function gateCallKey(request: GateRequest): string {
  const detail = describeGateRequest(request);
  const head = detail.trim().split(/[\s/\\]+/)[0]?.toLowerCase() ?? "";
  return `${request.toolName}:${head}`;
}

/**
 * The same key for a denial the stream reported, so a refusal seen after the
 * fact and the retry that arrives at the gate are recognised as one capability.
 *
 * Kept beside `gateCallKey` deliberately: the two must agree, and a test pins
 * that they do.
 */
export function denialCallKey(tool: string, command: string | undefined): string {
  const head = (command ?? "").trim().split(/[\s/\\]+/)[0]?.toLowerCase() ?? "";
  return `${tool}:${head}`;
}

/** What the gate script writes when a decision arrives. */
export interface GateDecisionFile {
  decision: GateDecision;
  reason?: string;
}

/**
 * The hook's stdout for a decision, or an empty string for `pass`.
 *
 * `pass` must emit **nothing**: any `permissionDecision` at all overrides the
 * CLI's own classifier, so passing by saying "allow" would silently grant
 * everything the gate declined to hold.
 */
export function gateHookOutput(
  decision: GateDecision,
  reason?: string,
): string {
  if (decision === "pass") return "";
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason:
        reason ?? (decision === "allow" ? "Approved in Task Workspaces." : "Denied in Task Workspaces."),
    },
  })}\n`;
}

/**
 * The settings file handed to the CLI via `--settings`.
 *
 * Written to a path the extension owns, never the user's
 * `.claude/settings.local.json`: the gate is machinery for one run, and a
 * user-owned file must not accumulate it. Their own settings still apply — this
 * one is layered on top.
 */
export function buildGateSettings(options: {
  /** Absolute path to the gate script. */
  scriptPath: string;
  /** How the script is launched, e.g. "node". */
  interpreter: string;
  /** Directory the script exchanges request and decision files in. */
  inboxPath: string;
  /**
   * How long the hook may hold the CLI open. Generous because the whole point is
   * to wait for a person; verified honoured to 282s.
   */
  timeoutSeconds: number;
  /** Tools to gate. A `PreToolUse` matcher is an anchored regex alternation. */
  tools: readonly string[];
}): Record<string, unknown> {
  const command = `${quote(options.interpreter)} ${quote(options.scriptPath)} ${quote(options.inboxPath)}`;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: options.tools.join("|"),
          hooks: [
            {
              type: "command",
              command,
              timeout: options.timeoutSeconds,
            },
          ],
        },
      ],
    },
  };
}

/** Paths routinely contain spaces on Windows, and the hook command is shelled. */
function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
