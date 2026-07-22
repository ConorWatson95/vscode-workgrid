import { execFile } from "node:child_process";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { AgentSession, AgentSessionStatus } from "../domain/agentSession";
import { AgentProvider, StartAgentRequest, AgentLogEntry } from "./agentProvider";
import { TerminalManager } from "../processes/terminalManager";
import { Logger } from "../logging/logger";

/**
 * First-party provider that launches the Claude Code CLI in an integrated
 * terminal rooted at the task's worktree. Running through the real CLI (rather
 * than the SDK) preserves existing auth, subscription usage, `.claude/*`
 * configuration, CLAUDE.md and permission settings.
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";

  constructor(
    private readonly terminals: TerminalManager,
    private readonly logger: Logger,
    private readonly command: () => string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        this.command(),
        ["--version"],
        { windowsHide: true, timeout: 10_000 },
        (error) => {
          if (error) {
            this.logger.warn(`Claude CLI not available: ${error.message}`);
          }
          resolve(!error);
        },
      );
    });
  }

  async startSession(
    workspace: TaskWorkspace,
    request: StartAgentRequest,
  ): Promise<AgentSession> {
    const terminal = this.terminals.createTerminal(
      workspace.id,
      workspace.name,
      workspace.worktreePath,
    );
    terminal.show(true);

    const args = buildClaudeArgs(request);
    // sendText writes the command line; the CLI keeps the user's own auth.
    terminal.sendText(`${this.command()} ${args}`.trim(), true);

    const pid = await terminal.processId;
    this.logger.info(
      `Started Claude Code for task "${workspace.name}" (pid=${pid ?? "unknown"}).`,
    );

    return {
      provider: this.id,
      processId: pid,
      status: "running",
      startedAt: this.clock(),
    };
  }

  async stopSession(session: AgentSession): Promise<void> {
    // We cannot reliably map a session back to its terminal here; the caller
    // (command layer) disposes the terminal via TerminalManager by task id.
    session.status = "stopped";
    session.stoppedAt = this.clock();
  }

  async getStatus(session: AgentSession): Promise<AgentSessionStatus> {
    return session.status;
  }

  async getLogs(_session: AgentSession): Promise<AgentLogEntry[]> {
    // Terminal-backed sessions expose no structured logs in the MVP.
    return [];
  }
}

/** Builds the CLI argument string from a start request. */
export function buildClaudeArgs(request: StartAgentRequest): string {
  const parts: string[] = [];
  const prompt = composePrompt(request);
  if (prompt) {
    // Quote the prompt so shells treat it as a single argument.
    parts.push(quote(prompt));
  }
  return parts.join(" ");
}

function composePrompt(request: StartAgentRequest): string | undefined {
  const segments: string[] = [];
  if (request.workflow) segments.push(request.workflow.trim());
  if (request.initialPrompt) segments.push(request.initialPrompt.trim());
  const combined = segments.join(" ").trim();
  return combined.length > 0 ? combined : undefined;
}

function quote(value: string): string {
  const escaped = value.replace(/"/g, '\\"');
  return `"${escaped}"`;
}
