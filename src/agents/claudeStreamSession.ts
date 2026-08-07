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
  mcpServersOf,
  mcpServerErrorsOf,
  modelOf,
  shortModelName,
  rateLimitOf,
  costUsdOf,
  RateLimitStatus,
  McpServerStatus,
  McpServerError,
  isTurnComplete,
  encodeUserMessage,
  contextTokensOf,
  sessionTokensOf,
  compactInfoOf,
} from "./streamJson";
import { SessionTokenTotals } from "../domain/taskPipeline";
import {
  HANDOFF_PROMPT,
  Handoff,
  formatHandoffBrief,
  isEmptyHandoff,
  parseHandoff,
} from "./handoff";
import { buildCliArgs } from "./claudeCliArgs";
import { redactSecrets } from "../domain/secretRedaction";

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
   * Load only `mcpConfigPath` and ignore every other source of MCP servers
   * (`--strict-mcp-config`).
   *
   * Set when the caller has deliberately reduced the server set, because
   * `--mcp-config` on its own *adds*: the worktree's own approved `.mcp.json`
   * would otherwise start every server regardless.
   */
  strictMcpConfig?: boolean;
  /**
   * Absolute path to an extra settings file (`--settings`), layered over the
   * user's own. Used to install the permission gate hook, which holds a tool call
   * open while the user decides instead of letting it be refused outright.
   */
  settingsPath?: string;
  /**
   * Plugin directories loaded with `--plugin-dir`, absolute. Carries the harness's
   * protocol skill, which lives under the git common dir rather than in the worktree.
   */
  pluginDirs?: string[];
  /** Further MCP configs, e.g. the extension's own ask_user server. */
  extraMcpConfigPaths?: string[];
  /**
   * Environment overrides for this process, layered over the extension's own.
   *
   * Used to bound a stage's subagent fan-out (`domain/subagentLimits.ts`). Set per
   * session rather than globally so a chat session the user is driving by hand
   * keeps the CLI's defaults — the cap exists to protect *concurrent tasks* from
   * each other, and a hand-driven session has no concurrent tasks to protect.
   */
  env?: Record<string, string>;
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
  /**
   * MCP startup, as reported on the init event — fired once, before the first
   * turn. A stage that declared required servers decides here whether to run at
   * all, which is the only moment it can: after this the model is already acting.
   */
  mcp: [{ servers: McpServerStatus[]; errors: McpServerError[] }];
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
  /**
   * What the CLI said went wrong, when it did.
   *
   * Kept because the alternative is what callers had: a boolean. A stage that
   * failed reported "the agent reported an error" and the actual cause -- a turn
   * limit, a rate limit, a spawn failure -- was in a transcript item nobody
   * persisted. The one thing a failure has to carry is why.
   */
  lastTurnError?: string;
  /** Approximate current context size in tokens (from the latest usage). */
  contextTokens = 0;
  /** Model the CLI reported for this session (short form), once known. */
  activeModel?: string;
  /** Latest plan usage / rate-limit state reported by the CLI. */
  rateLimit?: RateLimitStatus;
  /** Cumulative cost of this session in USD. */
  costUsd?: number;
  /**
   * Cumulative tokens for this session, from the latest `result` event.
   *
   * Distinct from `contextTokens`, which is the current context size and resets
   * to zero on compaction. This one only grows, and is what a stage persists.
   */
  tokenTotals?: SessionTokenTotals;
  /** True between issuing `/compact` and seeing its result, for feedback. */
  private compacting = false;
  /** True between asking for a handoff and consuming the reply. */
  private awaitingHandoff = false;
  /** When the CLI was spawned, so startup latency can be reported. */
  private spawnedAtMs?: number;
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
      strictMcpConfig: this.options.strictMcpConfig,
      settingsPath: this.options.settingsPath,
      pluginDirs: this.options.pluginDirs,
      extraMcpConfigPaths: this.options.extraMcpConfigPaths,
      useShell,
    });

    this.logger.info(`Starting Claude stream session in ${this.options.worktreePath}`);
    if (this.options.mcpConfigPath) {
      this.logger.info(`MCP servers from ${this.options.mcpConfigPath}`);
    }
    if (this.options.settingsPath) {
      this.logger.info(`Permission gate active (${this.options.settingsPath}).`);
    }
    // Stamped so the init event can say how long startup actually took. The gap
    // between spawning and the CLI's first output is routinely minutes on a
    // repository with MCP servers, and with nothing logged in between it reads
    // as the extension having stalled.
    this.spawnedAtMs = Date.now();
    this.child = spawn(this.options.command, args, {
      cwd: this.options.worktreePath,
      windowsHide: true,
      shell: useShell,
      // Layered over the inherited environment, never replacing it: the CLI needs
      // PATH, HOME and its own credential variables, and an env of only our
      // overrides is a process that cannot find `claude` at all.
      ...(this.options.env ? { env: { ...process.env, ...this.options.env } } : {}),
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
    this.lastTurnError = undefined;
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
      // Reported together, because the interesting question on a slow start is
      // not which model it picked but what the wait was spent on.
      const startup =
        this.spawnedAtMs === undefined
          ? ""
          : ` — ready in ${((Date.now() - this.spawnedAtMs) / 1000).toFixed(1)}s`;
      this.logger.info(`Session model: ${model}${startup}`);
      this.emitter.emit("model", this.activeModel);

      const servers = mcpServersOf(event);
      const mcpErrors = mcpServerErrorsOf(event);
      if (mcpErrors && mcpErrors.length > 0) {
        // Distinct from a failed connection and reported separately: this entry
        // was rejected as configuration, so the fix is in a file rather than in
        // whatever the server talks to.
        this.logger.error(
          `${mcpErrors.length} MCP config entr(ies) rejected at startup: ` +
            mcpErrors.map((e) => `${e.name} — ${e.message}`).join("; "),
        );
      }
      // Emitted even when both are empty: a stage waiting on this needs to know
      // the init event happened, and "no servers" is a legitimate answer to it.
      this.emitter.emit("mcp", { servers: servers ?? [], errors: mcpErrors ?? [] });
      if (servers && servers.length > 0) {
        // Named individually: a server that failed still cost its whole
        // connection attempt, and it is the one worth removing from the config.
        this.logger.info(
          `MCP servers ready (${servers.length}): ` +
            servers.map((s) => `${s.name}=${s.status}`).join(", "),
        );
        const failed = servers.filter((s) => s.status !== "connected");
        if (failed.length > 0) {
          this.logger.warn(
            `${failed.length} MCP server(s) did not connect: ` +
              `${failed.map((s) => s.name).join(", ")}. ` +
              "They still cost startup time on every subtask.",
          );
        }
      }
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

    // Logged on the turn's result, because a route's cost is otherwise
    // unattributable: it spawns a dozen sessions and the only visible number is a
    // total. Cache reads specifically, since a fresh session per subtask means
    // every prompt is a candidate for reuse and nothing said whether any of it was.
    if (event.type === "result") {
      // Kept as well as logged. The log answers "what is happening"; the field is
      // what survives the session, and a stage's report and any comparison
      // between two ways of running one are downstream of it.
      const totals = sessionTokensOf(event);
      if (totals) this.tokenTotals = totals;

      const usage = event.usage ?? event.message?.usage;
      const cached = usage?.cache_read_input_tokens ?? 0;
      const fresh = usage?.input_tokens ?? 0;
      if (cached > 0 || fresh > 0) {
        const share = cached + fresh > 0 ? Math.round((cached / (cached + fresh)) * 100) : 0;
        this.logger.info(
          `Session usage: ${fresh.toLocaleString("en-GB")} fresh input tokens, ` +
            `${cached.toLocaleString("en-GB")} from cache (${share}% cached)` +
            (this.costUsd !== undefined ? `, $${this.costUsd.toFixed(4)} so far` : ""),
        );
      }
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
        // The CLI's own words first, then its subtype (e.g. "error_max_turns"),
        // then stderr. Any of the three beats a generic sentence.
        this.lastTurnError =
          (typeof event.result === "string" && event.result.trim()) ||
          event.subtype ||
          this.stderrTail.trim() ||
          undefined;
        const detail = this.stderrTail.trim();
        // Emitted as an item, not only logged, so the stage runner's activity
        // watcher can keep it: for a session that failed before calling a tool
        // this is the only trace of it, and it was previously pushed only when
        // stderr had something in it — leaving an error that arrived in the
        // result event itself with nowhere to go.
        const trace = [this.lastTurnError, detail !== this.lastTurnError ? detail : ""]
          .filter((part) => part && part.length > 0)
          .join("\n");
        if (trace) this.pushItem({ kind: "tool-result", text: trace, isError: true });
        // Logged here, at error level, because this is the only place the CLI's
        // account of the failure exists. stderr goes to debug — which a
        // LogOutputChannel discards unless someone has set the level to Debug —
        // so a failed stage used to produce exactly one line, the generic
        // sentence, and the cause was thrown away before anyone could ask for it.
        // Redacted: a failing deployment command reports itself back in full.
        this.logger.error(
          "Claude turn errored" +
            (event.subtype ? ` (${event.subtype})` : "") +
            (this.lastTurnError ? `: ${redactSecrets(this.lastTurnError)}` : "") +
            (detail && detail !== this.lastTurnError
              ? `\nstderr: ${redactSecrets(detail)}`
              : ""),
        );
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
