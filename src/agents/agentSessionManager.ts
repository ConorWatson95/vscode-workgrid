import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { ClaudeStreamSession, StreamSessionOptions } from "./claudeStreamSession";
import { Logger } from "../logging/logger";

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
