import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { ChatItem, parseStreamLine, toChatItems } from "./streamJson";
import { normaliseKey } from "./nativeSessionWatcher";

export interface SessionSummary {
  id: string;
  title: string;
  mtimeMs: number;
}

/** Resolves the Claude project bucket directory for a worktree, if it exists. */
export function resolveProjectDir(
  homeDir: string,
  worktreePath: string,
): string | undefined {
  const projects = path.join(homeDir, ".claude", "projects");
  const key = normaliseKey(worktreePath);
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (normaliseKey(name) === key) return path.join(projects, name);
  }
  return undefined;
}

/**
 * Cap on how much of a transcript is read.
 *
 * Transcripts reach tens of MB, so reading one whole is expensive; the read is
 * async precisely so that cost isn't paid on the extension host's thread. The
 * cap only exists as a backstop against a pathologically large file — it has to
 * comfortably exceed a full session, since undershooting silently hides
 * history.
 */
const MAX_TRANSCRIPT_BYTES = 24 * 1024 * 1024;

/**
 * How many renderable items a replayed conversation keeps.
 *
 * Generous on purpose: a real 3,600-entry session produced 2,040 items, so the
 * previous cap of 300 dropped ~85% of the conversation — which read as history
 * going missing. When it does bind, `truncationNotice` says so rather than
 * leaving a silent gap.
 */
const MAX_ITEMS = 4000;

/** Marks where dropped history would have been, so a gap is never silent. */
function truncationNotice(dropped: number): ChatItem {
  return {
    kind: "system",
    text: `${dropped.toLocaleString()} earlier message${dropped === 1 ? "" : "s"} not shown — open the session in the CLI for the full history.`,
  };
}

/** Turns raw transcript text into capped chat items, flagging any gap. */
function parseItems(
  tail: { text: string; truncated: boolean },
  maxItems: number,
): ChatItem[] {
  const items: ChatItem[] = [];
  // Resuming a conversation re-appends its earlier entries to the same
  // transcript, verbatim and with their original uuid and timestamp. Rendering
  // the file as-is therefore replays the opening messages partway through. Keep
  // the first occurrence of each uuid and skip repeats.
  const seen = new Set<string>();
  for (const line of tail.text.split("\n")) {
    const event = parseStreamLine(line);
    if (!event) continue;
    if (event.uuid) {
      if (seen.has(event.uuid)) continue;
      seen.add(event.uuid);
    }
    // Replaying a saved transcript: include the user's typed turns.
    for (const item of toChatItems(event, true)) items.push(item);
  }

  const kept = items.slice(-maxItems);
  const droppedByCount = items.length - kept.length;
  // Either cap can bite: too many items, or a file bigger than the byte cap.
  if (droppedByCount > 0) kept.unshift(truncationNotice(droppedByCount));
  else if (tail.truncated) {
    kept.unshift({
      kind: "system",
      text: "Earlier messages not shown — this conversation is too large to replay in full.",
    });
  }
  return kept;
}

/**
 * Parses a transcript file into renderable chat items (most recent capped).
 *
 * Async so a multi-MB read doesn't block the extension host; opening a chat
 * awaits this behind a progress indicator.
 */
export async function loadItemsFromFile(
  file: string,
  maxItems = MAX_ITEMS,
): Promise<ChatItem[]> {
  const tail = await readTail(file, MAX_TRANSCRIPT_BYTES);
  return tail === undefined ? [] : parseItems(tail, maxItems);
}

/**
 * Synchronous variant, for the in-window paths (switching mode or model,
 * resuming, opening an old session) whose callers must return a session
 * immediately. Those normally carry the transcript in memory and only fall back
 * to disk, so the read is rare.
 */
export function loadItemsFromFileSync(file: string, maxItems = MAX_ITEMS): ChatItem[] {
  const tail = readTailSync(file, MAX_TRANSCRIPT_BYTES);
  return tail === undefined ? [] : parseItems(tail, maxItems);
}

/**
 * Loads a prior Claude session transcript from `~/.claude/projects` by id and
 * maps it to renderable chat items, so a resumed session's history shows.
 */
export async function loadTranscriptItems(
  homeDir: string,
  sessionId: string,
  maxItems = MAX_ITEMS,
): Promise<ChatItem[]> {
  const file = findTranscript(homeDir, sessionId);
  return file ? loadItemsFromFile(file, maxItems) : [];
}

/** Synchronous counterpart of {@link loadTranscriptItems}. */
export function loadTranscriptItemsSync(
  homeDir: string,
  sessionId: string,
  maxItems = MAX_ITEMS,
): ChatItem[] {
  const file = findTranscript(homeDir, sessionId);
  return file ? loadItemsFromFileSync(file, maxItems) : [];
}

/** Lists prior sessions for a worktree, newest first, with their titles. */
export function listSessions(
  homeDir: string,
  worktreePath: string,
  max = 30,
): SessionSummary[] {
  const dir = resolveProjectDir(homeDir, worktreePath);
  if (!dir) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      const id = entry.replace(/\.jsonl$/, "");
      summaries.push({
        id,
        title: readTranscriptTitle(file) ?? fallbackTitle(id),
        mtimeMs,
      });
    } catch {
      /* file vanished — skip */
    }
  }
  return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
}

/** True when a transcript file exists on disk for the given session id. */
export function transcriptExists(homeDir: string, sessionId: string): boolean {
  return findTranscript(homeDir, sessionId) !== undefined;
}

function findTranscript(homeDir: string, sessionId: string): string | undefined {
  const projects = path.join(homeDir, ".claude", "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Derives a human title for a transcript. Preference order:
 *   ai-title → last-prompt → first user message → undefined.
 * Reads only the head and tail chunks so it stays cheap on large files, and
 * never returns the session-id (callers supply a friendly fallback).
 */
export function readTranscriptTitle(file: string): string | undefined {
  const tail = readChunk(file, "tail");
  let title: string | undefined;
  let lastPrompt: string | undefined;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { type?: string; aiTitle?: string; lastPrompt?: string };
      if (o.type === "ai-title" && o.aiTitle) title = o.aiTitle;
      else if (o.type === "last-prompt" && o.lastPrompt) lastPrompt = o.lastPrompt;
    } catch {
      /* partial tail line */
    }
  }

  // No generated title yet (e.g. a fresh session) — use the first user prompt.
  const firstUser = title || lastPrompt ? undefined : firstUserText(readChunk(file, "head"));

  const chosen = title ?? lastPrompt ?? firstUser;
  return chosen ? clean(chosen) : undefined;
}

/** A friendly fallback label when no title can be derived, avoiding raw GUIDs. */
export function fallbackTitle(sessionId: string): string {
  return `Session ${sessionId.slice(0, 8)}`;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Extracts the text of the first user turn from a transcript head chunk. */
function firstUserText(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let o: { type?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "user") continue;
    const content = o.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const text = (block as { text?: string }).text;
          if (text && text.trim()) return text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Reads at most the last `maxBytes` of a file as UTF-8, returning undefined if
 * it can't be read. When truncated, the leading partial line is dropped so the
 * caller never sees a half-JSON line (and a multi-byte character can't be split
 * across the boundary), and `truncated` says so.
 */
async function readTail(
  file: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | undefined> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    if (length === size) return { text, truncated: false };
    const firstBreak = text.indexOf("\n");
    return {
      text: firstBreak === -1 ? "" : text.slice(firstBreak + 1),
      truncated: true,
    };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Synchronous counterpart of {@link readTail}, sharing its truncation rules. */
function readTailSync(
  file: string,
  maxBytes: number,
): { text: string; truncated: boolean } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    if (length === size) return { text, truncated: false };
    const firstBreak = text.indexOf("\n");
    return { text: firstBreak === -1 ? "" : text.slice(firstBreak + 1), truncated: true };
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads the first or last 64KB of a file as UTF-8. */
function readChunk(file: string, which: "head" | "tail"): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      const position = which === "tail" ? size - length : 0;
      fs.readSync(fd, buffer, 0, length, position);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
