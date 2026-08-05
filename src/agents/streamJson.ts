/**
 * Types and pure helpers for the Claude Code stream-json protocol
 * (`--output-format stream-json`). Each stdout line is one JSON event. We
 * normalise the events we care about into flat `ChatItem`s the UI can render.
 *
 * Parsing is isolated here (no I/O) so it can be unit-tested against fixtures.
 */

import type { SessionTokenTotals } from "../domain/taskPipeline";

/** A renderable entry in the chat transcript. */
export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  /** `id` is the block's tool_use id, when the stream carried one. */
  | {
      kind: "tool";
      name: string;
      /** One-line summary, capped for a chat row. */
      detail?: string;
      /**
       * The same value uncapped and with its line breaks intact.
       *
       * `detail` is truncated to 120 characters for display, which is fine in a
       * chat row and wrong everywhere else: the stage report recorded it verbatim,
       * so a long file path arrived already ending in an ellipsis and a path is
       * exactly the thing that has to be complete to be any use.
       */
      detailFull?: string;
      id?: string;
    }
  /** `callId` is the tool_use this result answers, when the stream carried one. */
  | {
      kind: "tool-result";
      /** Capped at 500 characters and flattened to one line, for a chat row. */
      text: string;
      /** Uncapped and unflattened, so recorded output keeps its shape. */
      textFull?: string;
      isError: boolean;
      callId?: string;
    }
  | { kind: "result"; text: string; isError: boolean }
  | { kind: "system"; text: string };

/** Minimal shape of an Anthropic-style content block. */
interface ContentBlock {
  type: string;
  /** Present on tool_use. */
  id?: string;
  /** Present on tool_result: the tool_use it answers. */
  tool_use_id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  /**
   * Stable per-entry id in a saved transcript. Resuming re-appends earlier
   * entries verbatim — same uuid, same timestamp — so this is what identifies a
   * repeat when replaying.
   */
  uuid?: string;
  /** Present on a system/init event: the model the CLI actually resolved to. */
  model?: string;
  result?: string;
  is_error?: boolean;
  /** Synthetic/meta entries (slash-command expansions, caveats) — not shown. */
  isMeta?: boolean;
  /**
   * Set on the summary `/compact` injects as the new conversation head. It is
   * a `user` entry but is *not* flagged `isMeta`, so it has to be recognised
   * explicitly or the whole summary renders as a giant user message on replay.
   */
  isCompactSummary?: boolean;
  usage?: Usage;
  /** Present on a system/compact_boundary event emitted after `/compact`. */
  compact_metadata?: { pre_tokens?: number; trigger?: string };
  /** The same metadata as written to the saved transcript, in camelCase. */
  compactMetadata?: { preTokens?: number; postTokens?: number; trigger?: string };
  /** Present on a `rate_limit_event`, pushed unprompted as limits change. */
  rate_limit_info?: {
    status?: string;
    /** Epoch *seconds* (not ms) when the current window resets. */
    resetsAt?: number;
    rateLimitType?: string;
    overageStatus?: string;
    isUsingOverage?: boolean;
  };
  /** Cumulative session cost, on the `result` event. */
  total_cost_usd?: number;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
    usage?: Usage;
  };
}

/**
 * Approximate size of the model's current context from an event's usage: new
 * input + cached (read) + cache-creation input tokens. Returns undefined when
 * the event carries no per-message usage.
 *
 * **Only `message.usage` counts.** The top-level `usage` on a `result` event is
 * cumulative over the whole run, exactly like `total_cost_usd` — summing it
 * reports millions of tokens for a session that never exceeded 130k, and any
 * threshold compared against it fires on every turn.
 */
export function contextTokensOf(event: {
  message?: { usage?: Usage };
}): number | undefined {
  const u = event.message?.usage;
  if (!u) return undefined;
  const total =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  return total > 0 ? total : undefined;
}

/**
 * Cumulative token totals for the whole session, from a `result` event.
 *
 * The exact mirror image of `contextTokensOf` above, reading the same four field
 * names in the other place — and the distinction is the only thing that makes
 * either number meaningful:
 *
 * - `message.usage` is a *snapshot* of one turn's context. It is what a gauge or
 *   a compaction threshold wants, and summing it is nonsense.
 * - the top-level `usage` on `result` is the *run total*, like `total_cost_usd`.
 *   It is what a cost comparison wants, and reading only the final one per
 *   session is what keeps it from being counted several times over.
 *
 * Getting them the wrong way round does not fail loudly: it reports a plausible
 * number that is wrong by roughly the number of turns, which is exactly the size
 * of error that would make a benchmark of "did the handover brief pay for itself"
 * come out backwards.
 */
export function sessionTokensOf(event: StreamEvent): SessionTokenTotals | undefined {
  if (event.type !== "result") return undefined;
  const u = event.usage;
  if (!u) return undefined;
  const totals: SessionTokenTotals = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
  };
  // A result carrying an all-zero usage says nothing; undefined lets callers
  // distinguish "no measurement" from "measured as free", which the report needs
  // in order to avoid presenting a partial total as a complete one.
  const any =
    totals.input > 0 ||
    totals.output > 0 ||
    totals.cacheRead > 0 ||
    totals.cacheCreation > 0;
  return any ? totals : undefined;
}

/** Parses a single NDJSON line; returns null for blank or malformed lines. */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

/** Extracts the session id from a system/init event, if present. */
export function sessionIdOf(event: StreamEvent): string | undefined {
  if (event.type === "system" && event.subtype === "init") {
    return event.session_id;
  }
  return undefined;
}

/**
 * The model the CLI resolved for this session, from its system/init event.
 * Worth surfacing: `--model` is deterministic, but resuming without one can
 * report a different model than a fresh session would.
 */
export function modelOf(event: StreamEvent): string | undefined {
  if (event.type === "system" && event.subtype === "init") {
    return event.model;
  }
  return undefined;
}

/** An MCP server the CLI reported at startup, with how it ended up. */
export interface McpServerStatus {
  name: string;
  /** The CLI's own word, e.g. "connected", "failed". */
  status: string;
}

/**
 * MCP servers named in the init event.
 *
 * Worth reading because they are the usual explanation for a long gap between
 * spawning the CLI and its first output: every server in the config has to be
 * started and connected before the session is ready, and a stage session pays
 * that per subtask. Without this the wait is unattributable, and the natural
 * guess — that the model or the permission gate is slow — is wrong.
 */
export function mcpServersOf(event: StreamEvent): McpServerStatus[] | undefined {
  if (event.type !== "system" || event.subtype !== "init") return undefined;
  const servers = (event as { mcp_servers?: unknown }).mcp_servers;
  if (!Array.isArray(servers)) return undefined;

  const parsed: McpServerStatus[] = [];
  for (const entry of servers) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; status?: unknown };
    if (typeof record.name !== "string") continue;
    parsed.push({
      name: record.name,
      status: typeof record.status === "string" ? record.status : "unknown",
    });
  }
  return parsed;
}

/** Plan usage / rate-limit state, as the UI needs it. */
export interface RateLimitStatus {
  /** e.g. "allowed", "rejected". */
  status: string;
  /** e.g. "five_hour", "weekly". */
  windowType: string;
  /** Epoch milliseconds when the window resets, or undefined if unreported. */
  resetsAtMs?: number;
  isUsingOverage: boolean;
}

/**
 * Reads the `rate_limit_event` the CLI pushes as usage changes. This arrives
 * unprompted on the normal stream, so usage can be shown live without polling
 * or spending a turn on `/usage`.
 */
export function rateLimitOf(event: StreamEvent): RateLimitStatus | undefined {
  if (event.type !== "rate_limit_event" || !event.rate_limit_info) return undefined;
  const info = event.rate_limit_info;
  return {
    status: info.status ?? "unknown",
    windowType: info.rateLimitType ?? "unknown",
    // The CLI reports seconds; the UI works in milliseconds.
    resetsAtMs: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : undefined,
    isUsingOverage: info.isUsingOverage === true,
  };
}

/** Cumulative session cost in USD, reported on the `result` event. */
export function costUsdOf(event: StreamEvent): number | undefined {
  if (event.type !== "result") return undefined;
  return typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined;
}

/** Trims the vendor prefix for display: `claude-opus-5[1m]` -> `opus-5[1m]`. */
export function shortModelName(model: string): string {
  return model.replace(/^claude-/, "");
}

/**
 * Recognises the `system`/`compact_boundary` event Claude emits after a
 * `/compact`. Returns the pre-compaction context size (if reported), else
 * undefined for non-compaction events.
 */
export function compactInfoOf(
  event: StreamEvent,
): { preTokens?: number; postTokens?: number } | undefined {
  if (event.type === "system" && event.subtype === "compact_boundary") {
    // The live stream uses snake_case; the saved transcript uses camelCase.
    return {
      preTokens: event.compact_metadata?.pre_tokens ?? event.compactMetadata?.preTokens,
      postTokens: event.compactMetadata?.postTokens,
    };
  }
  return undefined;
}

/** Renders a compact boundary as a one-line divider, e.g. `474k → 15k`. */
export function compactMarkerText(info: { preTokens?: number; postTokens?: number }): string {
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  if (info.preTokens && info.postTokens) {
    return `Context compacted — ${k(info.preTokens)} → ${k(info.postTokens)} tokens`;
  }
  if (info.preTokens) return `Context compacted — was ${k(info.preTokens)} tokens`;
  return "Context compacted";
}

/** True once a `result` event has been seen (the current turn is complete). */
export function isTurnComplete(event: StreamEvent): boolean {
  return event.type === "result";
}

/**
 * Converts a stream event into zero or more renderable chat items.
 *
 * `includeUserText` controls how "user" events are treated. In a live stream we
 * render the user's own turn ourselves and the stream's user events only carry
 * tool results — so it stays false. When replaying a saved transcript, user
 * entries also contain the human's typed messages, so we pass true to surface
 * them as user bubbles.
 */
export function toChatItems(
  event: StreamEvent,
  includeUserText = false,
): ChatItem[] {
  // Skip synthetic entries: slash-command prompt expansions, local-command
  // caveats, etc. — these are noise in a human-readable transcript.
  if (event.isMeta) return [];

  // The `/compact` summary is injected as an ordinary `user` entry, so replaying
  // a compacted transcript would otherwise show the entire summary as something
  // the human typed. Suppress it; the boundary below marks the same spot.
  if (event.isCompactSummary) return [];

  switch (event.type) {
    case "system": {
      // Init/system events are not shown as transcript lines, except the
      // compaction boundary, which is worth a divider where history was cut.
      const compact = compactInfoOf(event);
      return compact ? [{ kind: "system", text: compactMarkerText(compact) }] : [];
    }

    case "assistant":
      return blocksToItems(event.message?.content, "assistant");

    case "user":
      return userEventItems(event.message?.content, includeUserText);

    case "result": {
      const text = typeof event.result === "string" ? event.result : "";
      // The final result text duplicates the last assistant message, so we
      // surface it only when it is an error. Fall back to the subtype (e.g.
      // "error_max_turns") so the cause isn't hidden behind a generic string.
      if (!event.is_error) return [];
      const detail = text || event.subtype || "Session ended with an error.";
      return [{ kind: "result", text: detail, isError: true }];
    }

    default:
      return [];
  }
}

function blocksToItems(
  content: ContentBlock[] | string | undefined,
  role: "assistant",
): ChatItem[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ kind: role, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ChatItem[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      items.push({ kind: role, text: block.text });
    } else if (block.type === "tool_use") {
      items.push({
        kind: "tool",
        name: block.name ?? "tool",
        detail: summariseToolInput(block.input),
        detailFull: fullToolInput(block.input),
        id: typeof block.id === "string" ? block.id : undefined,
      });
    }
  }
  return items;
}

function userEventItems(
  content: ContentBlock[] | string | undefined,
  includeUserText: boolean,
): ChatItem[] {
  // A plain string is the user's typed message.
  if (typeof content === "string") {
    if (!includeUserText) return [];
    const text = normaliseUserText(content);
    return text ? [{ kind: "user", text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ChatItem[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      const text = stringifyToolContent(block.content);
      if (text.length > 0) {
        items.push({
          kind: "tool-result",
          text,
          textFull: fullToolContent(block.content),
          isError: block.is_error === true,
          callId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        });
      }
    } else if (includeUserText && block.type === "text" && block.text) {
      const text = normaliseUserText(block.text);
      if (text) items.push({ kind: "user", text });
    }
  }
  return items;
}

/**
 * Cleans a user message for display: a slash-command invocation collapses to
 * just the command (e.g. "/init"); injected wrapper tags (command metadata,
 * IDE context, reminders) are stripped. Returns null when nothing remains.
 */
export function normaliseUserText(raw: string): string | null {
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(raw);
  if (cmd) return cmd[1].trim();

  const stripped = raw
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, "")
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

/** Produces a short, single-line summary of a tool_use input. */
export function summariseToolInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return truncate(input, 120);
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Prefer the most informative common fields.
    const candidate =
      obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.description;
    if (typeof candidate === "string") return truncate(candidate, 120);
    try {
      return truncate(JSON.stringify(obj), 120);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return truncate(content, 500);
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .filter(Boolean);
    return truncate(texts.join("\n"), 500);
  }
  return "";
}

/**
 * Ceiling on the full-fidelity copies, so a pathological tool argument cannot
 * grow a session's memory without bound. Well above any real path or listing,
 * and the recorder caps what it *persists* separately.
 */
const FULL_MAX = 40000;

/**
 * The tool's argument, uncapped for display purposes and with newlines intact.
 *
 * Separate from `summariseToolInput` rather than replacing it: the chat row wants
 * one short line, and the stage report wants the whole path. Sharing one value
 * meant whichever consumer came second got the wrong thing — and it was the report,
 * which recorded paths already ending in an ellipsis.
 */
function fullToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return clamp(input);
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const candidate =
      obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.description;
    if (typeof candidate === "string") return clamp(candidate);
    try {
      return clamp(JSON.stringify(obj));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A tool result's text, unflattened, so a listing keeps its lines. */
function fullToolContent(content: unknown): string | undefined {
  if (typeof content === "string") return clamp(content);
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .filter(Boolean);
    return clamp(texts.join("\n"));
  }
  return undefined;
}

function clamp(value: string): string {
  return value.length > FULL_MAX ? value.slice(0, FULL_MAX) : value;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Builds one NDJSON user-message line for `--input-format stream-json`. */
export function encodeUserMessage(text: string): string {
  const payload = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  return JSON.stringify(payload) + "\n";
}
