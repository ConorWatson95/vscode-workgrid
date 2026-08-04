/**
 * The file protocol between a blocking `ask_user` MCP tool and the extension.
 *
 * Why a tool: without one, a stage that lacks information has no way to get it.
 * It ends its session saying `NEEDS-INFO`, the questions are stored, and once
 * answered the **whole subtask runs again from scratch** — so the information
 * costs a re-run rather than a pause.
 *
 * An MCP `tools/call` can block, and its return value is a real tool result. So
 * the agent asks, freezes mid-turn, and continues with the answer in hand,
 * keeping everything it had already worked out. Verified against the CLI: a call
 * held 45s and the agent used the answer in the same turn.
 *
 * This is the same shape as the permission gate, and deliberately so — a request
 * file, a poll, an answer file. The difference is what comes back: the gate
 * answers `allow`/`deny`, this answers *content*.
 *
 * Pure and vscode-free.
 */

/** The MCP server's name, which prefixes its tools. */
export const ASK_SERVER_NAME = "taskworkspaces";

/** Fully-qualified tool name, as the CLI's permission layer sees it. */
export const ASK_TOOL_NAME = `mcp__${ASK_SERVER_NAME}__ask_user`;

/**
 * The allow rule the tool needs.
 *
 * Established by probing: under `acceptEdits` the server connects and the tool is
 * advertised, the agent calls it, and the permission layer denies it — the agent
 * then reports that it cannot ask, which is the same dead end as having no tool.
 */
export const ASK_TOOL_ALLOW_RULE = ASK_TOOL_NAME;

/** A question the agent is blocked on. */
export interface AskRequest {
  /** Identifies the request file, so an answer routes back to it. */
  id: string;
  questions: string[];
  /** Free text the agent offered about why it is asking. */
  context?: string;
}

/**
 * Reads a request written by the ask server.
 *
 * Tolerant: an unreadable request must not wedge a stage. Callers treat undefined
 * as "answer it with nothing" so the agent is told to carry on rather than
 * blocking until the tool timeout.
 */
export function parseAskRequest(id: string, text: string): AskRequest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  const body = raw as { questions?: unknown; context?: unknown };
  const questions = Array.isArray(body.questions)
    ? body.questions
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim())
    : [];
  if (questions.length === 0) return undefined;

  return {
    id,
    questions,
    context:
      typeof body.context === "string" && body.context.trim()
        ? body.context.trim()
        : undefined,
  };
}

/** What the extension writes back once the user has answered. */
export interface AskAnswerFile {
  /** One answer per question, in order. */
  answers: string[];
  /**
   * Set when nobody answered — the task was stopped, or the extension is going
   * away. The server turns it into a result telling the agent to proceed without
   * the information rather than leaving it blocked.
   */
  abandoned?: boolean;
}

/**
 * The text handed back to the agent as the tool's result.
 *
 * Questions are paired with their answers rather than concatenated, because a
 * stage asks several at once and an unlabelled list of answers is ambiguous — the
 * same reason they are stored as items.
 */
export function formatAskResult(
  questions: readonly string[],
  answers: readonly string[],
): string {
  const lines = questions.map(
    (question, index) =>
      `Q: ${question}\nA: ${answers[index]?.trim() || "(no answer given)"}`,
  );
  return `The operator answered:\n\n${lines.join("\n\n")}`;
}

/** Told to the agent when no answer is coming, so it stops waiting. */
export const ASK_ABANDONED_RESULT =
  "Nobody is available to answer. Proceed using your best judgement, and state " +
  "clearly in your reply which assumptions you had to make.";

/**
 * The MCP config naming the ask server.
 *
 * A separate file from the project's own `.mcp.json`: this one is machinery the
 * extension owns and rewrites per run, and merging it into a file the user
 * maintains would leave our server behind after an uninstall. `--mcp-config` is
 * variadic, so both are passed.
 */
export function buildAskMcpConfig(options: {
  interpreter: string;
  serverPath: string;
  inboxPath: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [ASK_SERVER_NAME]: {
        command: options.interpreter,
        // Passed as argv, not a shell string, so no quoting is involved.
        args: [options.serverPath, options.inboxPath],
      },
    },
  };
}
