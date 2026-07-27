/**
 * Types and pure helpers for the Claude Code stream-json protocol
 * (`--output-format stream-json`). Each stdout line is one JSON event. We
 * normalise the events we care about into flat `ChatItem`s the UI can render.
 *
 * Parsing is isolated here (no I/O) so it can be unit-tested against fixtures.
 */

/** A renderable entry in the chat transcript. */
export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "tool-result"; text: string; isError: boolean }
  | { kind: "result"; text: string; isError: boolean }
  | { kind: "system"; text: string };

/** Minimal shape of an Anthropic-style content block. */
interface ContentBlock {
  type: string;
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

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  /** Present on a system/init event: the model the CLI actually resolved to. */
  model?: string;
  result?: string;
  is_error?: boolean;
  /** Synthetic/meta entries (slash-command expansions, caveats) — not shown. */
  isMeta?: boolean;
  usage?: Usage;
  /** Present on a system/compact_boundary event emitted after `/compact`. */
  compact_metadata?: { pre_tokens?: number; trigger?: string };
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
    usage?: Usage;
  };
}

/**
 * Approximate size of the model's current context from an event's usage: new
 * input + cached (read) + cache-creation input tokens. Returns undefined when
 * the event carries no usage.
 */
export function contextTokensOf(event: {
  usage?: Usage;
  message?: { usage?: Usage };
}): number | undefined {
  const u = event.message?.usage ?? event.usage;
  if (!u) return undefined;
  const total =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  return total > 0 ? total : undefined;
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

/** Trims the vendor prefix for display: `claude-opus-5[1m]` -> `opus-5[1m]`. */
export function shortModelName(model: string): string {
  return model.replace(/^claude-/, "");
}

/**
 * Recognises the `system`/`compact_boundary` event Claude emits after a
 * `/compact`. Returns the pre-compaction context size (if reported), else
 * undefined for non-compaction events.
 */
export function compactInfoOf(event: StreamEvent): { preTokens?: number } | undefined {
  if (event.type === "system" && event.subtype === "compact_boundary") {
    return { preTokens: event.compact_metadata?.pre_tokens };
  }
  return undefined;
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

  switch (event.type) {
    case "system":
      // Init/system events are not shown as transcript lines by default.
      return [];

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
        items.push({ kind: "tool-result", text, isError: block.is_error === true });
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
