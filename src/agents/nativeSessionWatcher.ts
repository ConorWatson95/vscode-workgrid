import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { Logger } from "../logging/logger";
import { AgentActivity } from "../ui/statusPresentation";

/**
 * Best-effort activity signal for *native* Claude sessions (those running in a
 * separate window via the official extension, which exposes no state to us).
 *
 * Claude Code writes a transcript per session at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` and appends to it as it
 * works. We locate the transcript folder for a worktree by matching on a
 * normalised key (the on-disk encoding varies in case/separators), then infer
 * activity from the newest transcript's modification time:
 * Activity is inferred from two signals on the newest transcript:
 *   1. The last *conversational* entry (user, or assistant about to run tools) —
 *      when Claude still owes a response it is "working", even during a long
 *      "thinking" pause where nothing is written to disk.
 *   2. Recency, as a tie-breaker/fast-path: a very recent write is "working".
 *
 * Resulting activity:
 *   - last entry means Claude owes a reply, OR written in the last ~10s → "working"
 *   - otherwise, written within the idle window                       → "input-required"
 *   - older / none                                                    → no live session
 *
 * This is a heuristic over an undocumented on-disk layout — it can lag or miss,
 * and is guarded behind `taskWorkspaces.trackNativeActivity`.
 */

/** What the newest transcript's last conversational entry implies. */
type TranscriptState = "working" | "awaiting" | "unknown";
export class NativeSessionWatcher {
  private readonly projectsDir: string;
  private readonly emitter = new EventEmitter();
  /** normalisedKey -> last computed activity, for on-demand reads. */
  private readonly activities = new Map<string, AgentActivity | undefined>();
  /** normalisedKey -> last emitted activity bucket, for change detection. */
  private readonly buckets = new Map<string, AgentActivity | "none">();
  /** normalisedKey -> worktree path (registered tasks). */
  private readonly registered = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  static readonly WORKING_WINDOW_MS = 10_000;
  static readonly IDLE_WINDOW_MS = 5 * 60_000;
  /**
   * How long a "Claude owes a reply" state stays "working" with no further
   * writes. Kept short so a closed window (which stops writing mid-turn) reverts
   * to the git-derived phase rather than showing "working" forever. Genuine
   * thinking pauses stream progress well within this window.
   */
  static readonly STALL_WINDOW_MS = 90_000;
  static readonly POLL_MS = 4_000;
  static readonly TAIL_BYTES = 64 * 1024;

  constructor(
    homeDir: string,
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.projectsDir = path.join(homeDir, ".claude", "projects");
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.emitter.on("change", listener);
    return { dispose: () => this.emitter.off("change", listener) };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), NativeSessionWatcher.POLL_MS);
  }

  /** Registers a worktree and computes its activity immediately. */
  ensure(worktreePath: string): void {
    const key = normaliseKey(worktreePath);
    if (!this.registered.has(key)) {
      this.registered.set(key, worktreePath);
    }
    this.scanKey(key);
  }

  activityFor(worktreePath: string): AgentActivity | undefined {
    return this.activities.get(normaliseKey(worktreePath));
  }

  private poll(): void {
    let changed = false;
    for (const key of this.registered.keys()) {
      if (this.scanKey(key)) changed = true;
    }
    if (changed) this.emitter.emit("change");
  }

  /** Recomputes one key's activity; returns true if it changed. */
  private scanKey(key: string): boolean {
    const activity = this.computeActivity(key);
    this.activities.set(key, activity);
    const bucket = activity ?? "none";
    const previous = this.buckets.get(key);
    this.buckets.set(key, bucket);
    return previous !== undefined && previous !== bucket;
  }

  private computeActivity(key: string): AgentActivity | undefined {
    const newest = this.newestTranscript(key);
    if (!newest) return undefined;

    const age = this.now() - newest.mtime;

    // Claude still owes a reply (last entry is a user turn, or an assistant
    // turn ending in tool calls). Working through a short stall only — a closed
    // window stops writing mid-turn, so we must not show "working" forever.
    if (newest.state === "working") {
      return age < NativeSessionWatcher.STALL_WINDOW_MS ? "working" : undefined;
    }
    // Last entry was a completed assistant turn → your turn, while recent.
    if (newest.state === "awaiting") {
      return age < NativeSessionWatcher.IDLE_WINDOW_MS ? "input-required" : undefined;
    }
    // Couldn't classify: only trust a very recent write as activity.
    return age < NativeSessionWatcher.WORKING_WINDOW_MS ? "working" : undefined;
  }

  /** Newest transcript's mtime + classification of its last conv. entry. */
  private newestTranscript(
    key: string,
  ): { mtime: number; state: TranscriptState } | undefined {
    const dir = this.resolveProjectDir(key);
    if (!dir) return undefined;

    let newestPath: string | undefined;
    let newestMtime = 0;
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".jsonl")) continue;
        try {
          const stat = fs.statSync(path.join(dir, entry));
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newestPath = path.join(dir, entry);
          }
        } catch {
          /* file vanished between readdir and stat — ignore */
        }
      }
    } catch (error) {
      this.logger.debug(`native watcher: cannot read ${dir}: ${String(error)}`);
      return undefined;
    }

    if (!newestPath) return undefined;
    return { mtime: newestMtime, state: this.classifyTail(newestPath) };
  }

  /** Reads the file's tail and classifies the last conversational entry. */
  private classifyTail(filePath: string): TranscriptState {
    let tail: string;
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, NativeSessionWatcher.TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        tail = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "unknown";
    }

    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        // Likely a truncated first line from the tail window — skip it.
        continue;
      }
      const state = classifyEntry(obj);
      if (state) return state;
    }
    return "unknown";
  }

  /** Finds the project subdirectory whose name normalises to `key`. */
  private resolveProjectDir(key: string): string | undefined {
    let names: string[];
    try {
      names = fs.readdirSync(this.projectsDir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (normaliseKey(name) === key) {
        return path.join(this.projectsDir, name);
      }
    }
    return undefined;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Normalises a path or on-disk project-dir name to a comparable key: lowercase,
 * every run of non-alphanumerics collapsed to a single hyphen, trimmed. This
 * makes `C:\Dev\myrepo-task`, `c--Dev-myrepo-task` and `C--Dev-myrepo-task` all
 * compare equal.
 */
export function normaliseKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Classifies a single transcript entry. Returns null for non-conversational
 * meta entries (summary, last-prompt, ai-title, …) so callers can skip them.
 *
 * - user turn (including tool results) → Claude owes a reply → "working"
 * - assistant turn ending in tool calls → tools still to run → "working"
 * - assistant turn ending in text        → your turn         → "awaiting"
 */
export function classifyEntry(entry: unknown): "working" | "awaiting" | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as {
    type?: string;
    message?: { role?: string; content?: unknown };
  };

  if (e.type === "user") return "working";
  if (e.type !== "assistant") return null;

  const content = e.message?.content;
  if (Array.isArray(content)) {
    const hasToolUse = content.some(
      (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_use",
    );
    return hasToolUse ? "working" : "awaiting";
  }
  return "awaiting";
}
