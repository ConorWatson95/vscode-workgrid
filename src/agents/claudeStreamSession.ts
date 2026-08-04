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
import {
  HANDOFF_PROMPT,
  Handoff,
  formatHandoffBrief,
  isEmptyHandoff,
  parseHandoff,
} from "./handoff";
import { buildCliArgs } from "./claudeCliArgs";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface StreamSessionOptions {
  command: string;
  worktreePath: string;
  permissionMode: PermissionMode;
  /** Extra directories the agent may access (e.g. the main repo root). */
  addDirs?: string[];
  /**
   * Absolute path to an MCP config to load explicitly (`--mcp-config`).
   *
   * Needed because every task worktree is a directory the CLI has never seen, so
   * the project's `.mcp.json` is unapproved there and none of its servers start.
   */
  mcpConfigPath?: string;
  /**
   * Absolute path to an extra settings file (`--settings`), layered over the
   * user's own. Used to install the permission gate hook, which holds a tool call
   * open while the user decides instead of letting it be refused outright.
   */
  settingsPath?: string;
  /** Resume this existing Claude session id instead of starting a new one. */
  resumeSessionId?: string;
  /** Auto-compact once context exceeds this many tokens (0 = never). */
  autoCompactThreshold?: number;
  /** Model alias/id passed to `--model` (e.g. "opus"). Empty = CLI default. */
  model?: string;
  /**
   * What to do when the context exceeds `autoCompactThreshold`.
   * "compact" issues `/compact`; "checkpoint" writes a handoff and starts a
   * fresh session from it, keeping carried-forward context bounded.
   */
  contextStrategy?: "compact" | "checkpoint";
  /** Task name, used to orient a session resumed from a handoff. */
  taskName?: string;
  /** Called when a checkpoint is taken, so the handoff can be persisted. */
  onCheckpoint?: (checkpoint: {
    handoff: Handoff;
    /** The agent's raw reply, kept verbatim for inspection. */
    raw: string;
    /** The brief actually sent to the fresh session. */
    brief: string;
  }) => void;
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

  /** Mutable: a checkpoint restart mints a new id for the new transcript. */
  id: string;
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
  /** True between asking for a handoff and consuming the reply. */
  private awaitingHandoff = false;
  /**
   * Session to resume on the next spawn. Cleared by a checkpoint restart, which
   * must begin with an empty context rather than reloading the old transcript.
   */
  private resumeSessionId?: string;

  constructor(
    private readonly options: StreamSessionOptions,
    private readonly logger: Logger,
  ) {
    // Reuse the resumed id so the transcript continues in the same file.
    this.id = options.resumeSessionId ?? randomUUID();
    this.resumeSessionId = options.resumeSessionId;
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
    // On Windows the CLI is resolved via the shell (PATHEXT), which means the
    // shell re-parses the command line, so path arguments have to be quoted.
    const useShell = process.platform === "win32";
    const args = buildCliArgs({
      sessionId: this.id,
      resumeSessionId: this.resumeSessionId,
      permissionMode: this.options.permissionMode,
      model: this.options.model,
      addDirs: this.options.addDirs,
      mcpConfigPath: this.options.mcpConfigPath,
      settingsPath: this.options.settingsPath,
      useShell,
    });

    this.logger.info(`Starting Claude stream session in ${this.options.worktreePath}`);
    if (this.options.mcpConfigPath) {
      this.logger.info(`MCP servers from ${this.options.mcpConfigPath}`);
    }
    if (this.options.settingsPath) {
      this.logger.info(`Permission gate active (${this.options.settingsPath}).`);
    }
    this.child = spawn(this.options.command, args, {
      cwd: this.options.worktreePath,
      windowsHide: true,
      shell: useShell,
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
      // A pending handoff takes precedence: its reply is what we just received.
      if (this.awaitingHandoff) {
        this.completeCheckpoint();
      } else {
        this.maybeAutoCompact();
      }
    }
  }

  /**
   * Applies the configured context strategy once a turn settles.
   *
   * "compact" summarises in place — the context regrows and the operation is
   * slow. "checkpoint" asks for a written handoff and then starts a fresh
   * session from it, so the carried-forward state is bounded and inspectable.
   */
  private maybeAutoCompact(): void {
    const threshold = this.options.autoCompactThreshold ?? 0;
    if (threshold <= 0 || this.compacting || this.awaitingHandoff) return;
    if (this.contextTokens <= threshold) return;

    if ((this.options.contextStrategy ?? "compact") === "checkpoint") {
      this.logger.info(
        `Checkpointing: context ${this.contextTokens} > threshold ${threshold}.`,
      );
      this.pushItem({
        kind: "system",
        text: "Context over threshold — writing a handoff and starting a fresh session…",
      });
      this.awaitingHandoff = true;
      this.send(HANDOFF_PROMPT);
      return;
    }

    this.logger.info(
      `Auto-compacting: context ${this.contextTokens} > threshold ${threshold}.`,
    );
    this.pushItem({ kind: "system", text: "Context over threshold — compacting automatically…" });
    this.compact();
  }

  /**
   * Completes a checkpoint: parse the handoff the agent just wrote, persist it,
   * then replace this process with a fresh session briefed from it.
   *
   * On an empty handoff we fall back to `/compact` rather than clearing — losing
   * the conversation with nothing to resume from would be strictly worse than a
   * slow compaction.
   */
  private completeCheckpoint(): void {
    this.awaitingHandoff = false;

    const reply = [...this.items].reverse().find((item) => item.kind === "assistant");
    const raw = reply && "text" in reply ? reply.text : "";
    const { handoff, structured } = parseHandoff(raw);

    if (isEmptyHandoff(handoff)) {
      this.logger.warn("Checkpoint produced an empty handoff; compacting instead.");
      this.pushItem({
        kind: "system",
        text: "Handoff was empty — compacting instead of clearing.",
      });
      this.compact();
      return;
    }
    if (!structured) {
      this.logger.warn("Handoff had no recognised headings; carrying it forward as prose.");
    }

    const brief = formatHandoffBrief(handoff, { taskName: this.options.taskName });
    this.options.onCheckpoint?.({ handoff, raw, brief });

    const previousTokens = this.contextTokens;
    this.restartFresh(brief);
    this.pushItem({
      kind: "system",
      text:
        `Started a fresh session from a ${brief.length}-character handoff` +
        (previousTokens > 0 ? ` (was ~${Math.round(previousTokens / 1000)}k tokens).` : "."),
    });
  }

  /**
   * Tears down the current process and starts a new one with no `--resume`, so
   * the CLI begins with an empty context. A new session id is minted because the
   * fresh conversation is a new transcript, not a continuation of the old file.
   */
  private restartFresh(brief: string): void {
    this.stop();
    this.child = undefined;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.contextTokens = 0;
    this.compacting = false;
    this.sessionId = undefined;
    this.id = randomUUID();
    // A fresh process must not resume the old transcript.
    this.resumeSessionId = undefined;
    this.emitter.emit("compacted");
    this.start(brief);
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
