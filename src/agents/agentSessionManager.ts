import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { ClaudeStreamSession, StreamSessionOptions } from "./claudeStreamSession";
import { Logger } from "../logging/logger";
import { LiveAgentSession, queryLiveSessions, sessionsForWorktree } from "./claudeAgents";

/**
 * Owns the live headless chat sessions, keyed by task id, so a session survives
 * closing and re-opening its Webview panel. vscode-free.
 */
export class AgentSessionManager {
  private readonly sessions = new Map<string, ClaudeStreamSession>();
  private readonly changeEmitter = new EventEmitter();

  constructor(
    private readonly logger: Logger,
    private readonly commandResolver: () => string,
  ) {}

  /** Fires whenever any tracked session's status changes. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.changeEmitter.on("change", listener);
    return { dispose: () => this.changeEmitter.off("change", listener) };
  }

  isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        this.commandResolver(),
        ["--version"],
        { windowsHide: true, timeout: 10_000, shell: process.platform === "win32" },
        (error) => resolve(!error),
      );
    });
  }

  get(taskId: string): ClaudeStreamSession | undefined {
    return this.sessions.get(taskId);
  }

  /** All sessions the CLI reports as live, including ones we don't own. */
  listLive(): Promise<LiveAgentSession[]> {
    return queryLiveSessions(this.commandResolver(), this.logger);
  }

  /**
   * Live sessions running in `worktreePath` that this extension host does not
   * own — a leftover from a previous window, a terminal-mode session, or one
   * the user started themselves.
   *
   * Callers should treat these as advisory and never terminate them
   * automatically: the user's own interactive Claude sessions legitimately run
   * in these directories.
   */
  async findForeignSessions(
    taskId: string,
    worktreePath: string,
  ): Promise<LiveAgentSession[]> {
    const ours = this.sessions.get(taskId);
    const live = sessionsForWorktree(await this.listLive(), worktreePath);
    // Match on the CLI's own session id, which is what --resume keys on.
    return live.filter((s) => s.sessionId !== ours?.sessionId);
  }

  /**
   * Orchestrator entry point: reuse this task's live session if we own one,
   * otherwise report what else is running there so the caller can decide
   * between adopting, starting alongside, or cancelling.
   */
  async resolveSession(
    taskId: string,
    worktreePath: string,
  ): Promise<
    | { kind: "reuse"; session: ClaudeStreamSession }
    | { kind: "foreign"; sessions: LiveAgentSession[] }
    | { kind: "none" }
  > {
    const existing = this.sessions.get(taskId);
    if (existing && existing.status !== "stopped" && existing.status !== "failed") {
      return { kind: "reuse", session: existing };
    }
    const foreign = await this.findForeignSessions(taskId, worktreePath);
    return foreign.length > 0 ? { kind: "foreign", sessions: foreign } : { kind: "none" };
  }

  /** Returns the existing session for a task, or creates and starts a new one. */
  getOrStart(
    taskId: string,
    options: Omit<StreamSessionOptions, "command">,
    initialPrompt?: string,
  ): ClaudeStreamSession {
    const existing = this.sessions.get(taskId);
    if (existing) return existing;
    return this.create(taskId, options, initialPrompt);
  }

  /** Stops any existing session for a task and starts a fresh one. */
  create(
    taskId: string,
    options: Omit<StreamSessionOptions, "command">,
    initialPrompt?: string,
  ): ClaudeStreamSession {
    const existing = this.sessions.get(taskId);
    if (existing) existing.stop();

    const session = new ClaudeStreamSession(
      { ...options, command: this.commandResolver() },
      this.logger,
    );
    this.sessions.set(taskId, session);
    session.on("status", () => this.changeEmitter.emit("change"));
    session.start(initialPrompt);
    return session;
  }

  stop(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (session) {
      session.stop();
      this.sessions.delete(taskId);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }
}
