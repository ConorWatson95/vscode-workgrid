import * as fs from "node:fs";
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

/** Parses a transcript file into renderable chat items (most recent capped). */
export function loadItemsFromFile(file: string, maxItems = 300): ChatItem[] {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const items: ChatItem[] = [];
  for (const line of content.split("\n")) {
    const event = parseStreamLine(line);
    if (!event) continue;
    // Replaying a saved transcript: include the user's typed turns.
    for (const item of toChatItems(event, true)) items.push(item);
  }
  return items.slice(-maxItems);
}

/**
 * Loads a prior Claude session transcript from `~/.claude/projects` by id and
 * maps it to renderable chat items, so a resumed session's history shows.
 */
export function loadTranscriptItems(
  homeDir: string,
  sessionId: string,
  maxItems = 300,
): ChatItem[] {
  const file = findTranscript(homeDir, sessionId);
  return file ? loadItemsFromFile(file, maxItems) : [];
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
