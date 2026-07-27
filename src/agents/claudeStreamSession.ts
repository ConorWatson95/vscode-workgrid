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
  modelOf,
  shortModelName,
  rateLimitOf,
  costUsdOf,
  RateLimitStatus,
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
  /** Auto-compact once context exceeds this many tokens (0 = never). */
  autoCompactThreshold?: number;
  /** Model alias/id passed to `--model` (e.g. "opus"). Empty = CLI default. */
  model?: string;
}

type SessionEvents = {
  item: [ChatItem];
  status: [AgentSessionStatus];
  tokens: [number];
  /** Fired when a `/compact` completes; the gauge should show a placeholder. */
  compacted: [];
  /** The model the CLI resolved for this session, for display. */
  model: [string];
  /** Plan usage / rate-limit state, pushed by the CLI as it changes. */
  usage: [{ rateLimit?: RateLimitStatus; costUsd?: number }];
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
  /** Rolling tail of recent stderr, surfaced when a turn errors with no detail. */
  private stderrTail = "";

  readonly id: string;
  readonly items: ChatItem[] = [];
  status: AgentSessionStatus = "starting";
  sessionId?: string;
  /** True while a turn is in flight (input should be disabled). */
  busy = false;
  /**
   * True when the last completed turn ended in an error `result`. The CLI often
   * stays alive (status "waiting") after such a turn but won't produce useful
   * output on further input, so the next send should resume a fresh process.
   */
  lastTurnErrored = false;
  /** Approximate current context size in tokens (from the latest usage). */
  contextTokens = 0;
  /** Model the CLI reported for this session (short form), once known. */
  activeModel?: string;
  /** Latest plan usage / rate-limit state reported by the CLI. */
  rateLimit?: RateLimitStatus;
  /** Cumulative cost of this session in USD. */
  costUsd?: number;
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
    if (this.options.model && this.options.model.trim().length > 0) {
      args.push("--model", this.options.model.trim());
    }
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
      // Keep the last ~2KB so an error result can report the underlying cause.
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
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
    // Typing "/compact" is the same request as the Compact button, so track it
    // the same way — otherwise the marker is skipped and the context chip sits
    // on its stale pre-compact number.
    if (/^\/compact\b/.test(trimmed)) this.compacting = true;
    this.pushItem({ kind: "user", text: trimmed });
    this.busy = true;
    this.lastTurnErrored = false;
    this.stderrTail = "";
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

    const model = modelOf(event);
    if (model) {
      this.activeModel = shortModelName(model);
      this.logger.info(`Session model: ${model}`);
      this.emitter.emit("model", this.activeModel);
    }

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

    // Usage arrives unprompted (rate_limit_event) or on turn completion
    // (total_cost_usd), so the panel can show it live without polling.
    const rateLimit = rateLimitOf(event);
    const costUsd = costUsdOf(event);
    if (rateLimit || costUsd !== undefined) {
      if (rateLimit) this.rateLimit = rateLimit;
      if (costUsd !== undefined) this.costUsd = costUsd;
      this.emitter.emit("usage", { rateLimit: this.rateLimit, costUsd: this.costUsd });
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
      // Remember an errored turn so the next send resumes a fresh process
      // rather than writing into a CLI that has stopped responding.
      if (event.type === "result" && event.is_error) {
        this.lastTurnErrored = true;
        const detail = this.stderrTail.trim();
        if (detail) this.pushItem({ kind: "tool-result", text: detail, isError: true });
      }
      this.busy = false;
      this.setStatus("waiting");
      this.maybeAutoCompact();
    }
  }

  /** Auto-issues `/compact` when the context exceeds the configured threshold. */
  private maybeAutoCompact(): void {
    const threshold = this.options.autoCompactThreshold ?? 0;
    if (threshold > 0 && !this.compacting && this.contextTokens > threshold) {
      this.logger.info(
        `Auto-compacting: context ${this.contextTokens} > threshold ${threshold}.`,
      );
      this.pushItem({ kind: "system", text: "Context over threshold — compacting automatically…" });
      this.compact();
    }
  }

  /** Emits a transcript note confirming a `/compact`. */
  private announceCompaction(preTokens: number | undefined): void {
    if (!this.compacting) return;
    this.compacting = false;
    const before = preTokens ?? this.contextTokens;
    const freed = before > 0 ? ` — freed ~${Math.round(before / 1000)}k tokens` : "";
    this.pushItem({ kind: "system", text: `Context compacted${freed}.` });
    // Reset the counter so the next turn's usage (any value) refreshes the
    // gauge, and signal the panel to show a "compacted" placeholder in the
    // meantime — otherwise the chip sits on the stale pre-compact number and
    // looks like the compaction never happened.
    this.contextTokens = 0;
    this.emitter.emit("compacted");
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
