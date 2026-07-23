import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Logger } from "../logging/logger";
import { AgentSessionStatus } from "../domain/agentSession";
import {
  ChatItem,
  parseStreamLine,
  toChatItems,
  sessionIdOf,
  isTurnComplete,
  encodeUserMessage,
  contextTokensOf,
  compactInfoOf,
} from "./streamJson";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface StreamSessionOptions {
  command: string;
  worktreePath: string;
  permissionMode: PermissionMode;
  /** Extra directories the agent may access (e.g. the main repo root). */
  addDirs?: string[];
  /** Resume this existing Claude session id instead of starting a new one. */
  resumeSessionId?: string;
}

type SessionEvents = {
  item: [ChatItem];
  status: [AgentSessionStatus];
  tokens: [number];
};

/**
 * Drives a single headless Claude Code session over the stream-json protocol.
 * The CLI runs as an invisible child process (no terminal); events are parsed
 * from stdout and user turns are written to stdin. State (transcript + status)
 * lives here so a Webview panel can be closed and re-opened without losing it.
 *
 * vscode-free by design — only Node APIs — so the protocol handling is testable.
 */
export class ClaudeStreamSession {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private readonly emitter = new EventEmitter();

  readonly id: string;
  readonly items: ChatItem[] = [];
  status: AgentSessionStatus = "starting";
  sessionId?: string;
  /** True while a turn is in flight (input should be disabled). */
  busy = false;
  /** Approximate current context size in tokens (from the latest usage). */
  contextTokens = 0;
  /** True between issuing `/compact` and seeing its result, for feedback. */
  private compacting = false;

  constructor(
    private readonly options: StreamSessionOptions,
    private readonly logger: Logger,
  ) {
    // Reuse the resumed id so the transcript continues in the same file.
    this.id = options.resumeSessionId ?? randomUUID();
  }

  on<E extends keyof SessionEvents>(
    event: E,
    listener: (...args: SessionEvents[E]) => void,
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<E extends keyof SessionEvents>(
    event: E,
    listener: (...args: SessionEvents[E]) => void,
  ): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  /** Spawns the CLI. If an initial prompt is given, sends it as the first turn. */
  start(initialPrompt?: string): void {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      // Resume the existing session, or create one with a known id.
      ...(this.options.resumeSessionId
        ? ["--resume", this.options.resumeSessionId]
        : ["--session-id", this.id]),
      "--permission-mode",
      this.options.permissionMode,
    ];
    for (const dir of this.options.addDirs ?? []) {
      args.push("--add-dir", dir);
    }

    this.logger.info(`Starting Claude stream session in ${this.options.worktreePath}`);
    this.child = spawn(this.options.command, args, {
      cwd: this.options.worktreePath,
      windowsHide: true,
      // On Windows the CLI is resolved via the shell (PATHEXT). Args are all
      // static flags + a generated UUID — no free text — so this is safe.
      shell: process.platform === "win32",
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.logger.debug(`claude stderr: ${chunk.trimEnd()}`);
    });
    this.child.on("error", (error) => {
      this.logger.error("Claude session process error", error);
      this.pushItem({ kind: "result", text: `Failed to start Claude: ${error.message}`, isError: true });
      this.setStatus("failed");
    });
    this.child.on("close", (code) => {
      this.logger.info(`Claude session closed (code=${code ?? "null"}).`);
      this.busy = false;
      this.setStatus(code === 0 || code === null ? "stopped" : "failed");
    });

    if (initialPrompt && initialPrompt.trim().length > 0) {
      this.setStatus("running");
      this.send(initialPrompt);
    } else {
      // Spawned and idle, waiting for the user to type the first message.
      this.setStatus("waiting");
    }
  }

  /** Sends a user turn to the running session. */
  send(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (!this.child || this.child.exitCode !== null) {
      this.logger.warn("Cannot send message: session is not running.");
      return;
    }
    this.pushItem({ kind: "user", text: trimmed });
    this.busy = true;
    this.setStatus("running");
    this.child.stdin.write(encodeUserMessage(trimmed));
  }

  /** Asks Claude to compact the conversation context. */
  compact(): void {
    this.compacting = true;
    this.send("/compact");
  }

  /** Terminates the session process. */
  stop(): void {
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.end();
      this.child.kill();
    }
    this.busy = false;
    this.setStatus("stopped");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const event = parseStreamLine(line);
    if (!event) return;

    const sid = sessionIdOf(event);
    if (sid) this.sessionId = sid;

    // A compaction boundary: confirm it and drop the context indicator — the
    // next turn's usage repopulates it with the compacted size.
    const compact = compactInfoOf(event);
    if (compact) {
      this.announceCompaction(compact.preTokens);
      return;
    }

    // Any assistant/tool activity means Claude is working — flip back to
    // "running" even if a previous turn just completed (e.g. a queued
    // follow-up message is now being processed).
    if (event.type === "assistant" || event.type === "user") {
      this.busy = true;
      this.setStatus("running");
    }

    const tokens = contextTokensOf(event);
    if (tokens !== undefined && tokens !== this.contextTokens) {
      this.contextTokens = tokens;
      this.emitter.emit("tokens", tokens);
    }

    for (const item of toChatItems(event)) {
      this.pushItem(item);
    }

    if (isTurnComplete(event)) {
      // Fallback: some CLI builds don't emit a compact_boundary event, so
      // confirm the compaction here if one is still pending.
      if (this.compacting) this.announceCompaction(undefined);
      this.busy = false;
      this.setStatus("waiting");
    }
  }

  /** Emits a transcript note confirming a `/compact` and resets the token gauge. */
  private announceCompaction(preTokens: number | undefined): void {
    if (!this.compacting) return;
    this.compacting = false;
    const before = preTokens ?? this.contextTokens;
    const freed = before > 0 ? ` — freed ~${Math.round(before / 1000)}k tokens` : "";
    this.pushItem({ kind: "system", text: `Context compacted${freed}.` });
    this.contextTokens = 0;
    this.emitter.emit("tokens", 0);
  }

  private pushItem(item: ChatItem): void {
    this.items.push(item);
    this.emitter.emit("item", item);
  }

  private setStatus(status: AgentSessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitter.emit("status", status);
  }
}
