import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { ClaudeStreamSession, StreamSessionOptions } from "./claudeStreamSession";
import { Logger } from "../logging/logger";
import { LiveAgentSession, queryLiveSessions, sessionsForWorktree } from "./claudeAgents";

/**
 * Where a spawned process is recorded, so it can be reaped after a crash.
 *
 * An interface rather than the class, so this module stays free of the filesystem
 * and its tests need no temp directory.
 */
export interface SessionProcessSink {
  record(entry: { pid: number; taskId: string; subtaskId?: string; stageName?: string }): Promise<void>;
  forget(pid: number): Promise<void>;
}

/**
 * Owns the live headless chat sessions, keyed by task id, so a session survives
 * closing and re-opening its Webview panel. vscode-free.
 */
export class AgentSessionManager {
  private readonly sessions = new Map<string, ClaudeStreamSession>();
  private readonly changeEmitter = new EventEmitter();

  /**
   * Notified when a session's process starts and stops, so a crashed extension host
   * leaves a durable trail. Optional and appended last: a manager built without it
   * behaves exactly as before, and every existing positional argument keeps its slot.
   * See `domain/sessionProcesses.ts`.
   */
  constructor(
    private readonly logger: Logger,
    private readonly commandResolver: () => string,
    private readonly processes?: SessionProcessSink,
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

  /**
   * Stops any existing session for a task and starts a fresh one.
   *
   * `identity` names the subtask the session is for, and is what makes the process
   * reapable after a crash: a record with no subtask is a hand-driven chat and is
   * never swept. Appended last so no existing call site shifts an argument.
   */
  create(
    taskId: string,
    options: Omit<StreamSessionOptions, "command">,
    initialPrompt?: string,
    identity?: { subtaskId?: string; stageName?: string },
  ): ClaudeStreamSession {
    const existing = this.sessions.get(taskId);
    if (existing) this.stopSession(existing);

    const session = new ClaudeStreamSession(
      { ...options, command: this.commandResolver() },
      this.logger,
    );
    this.sessions.set(taskId, session);
    session.on("status", () => this.changeEmitter.emit("change"));
    session.start(initialPrompt);
    // After start(), which is where the process is spawned and the pid exists.
    const pid = session.pid;
    if (pid !== undefined) {
      void this.processes?.record({ pid, taskId, ...identity });
    }
    return session;
  }

  /**
   * Stops a session and clears its record.
   *
   * The pid has to be read before stopping, because `stop()` drops the child. A
   * cleanly stopped process must leave no record behind, or the next sweep spends a
   * probe on a pid that is either gone or somebody else's.
   */
  private stopSession(session: ClaudeStreamSession): void {
    const pid = session.pid;
    session.stop();
    if (pid !== undefined) void this.processes?.forget(pid);
  }

  stop(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (session) {
      this.stopSession(session);
      this.sessions.delete(taskId);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.stopSession(session);
    }
    this.sessions.clear();
  }
}
