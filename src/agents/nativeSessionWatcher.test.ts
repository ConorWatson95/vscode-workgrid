import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NativeSessionWatcher,
  normaliseKey,
  classifyEntry,
} from "./nativeSessionWatcher";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe("normaliseKey", () => {
  it("makes windows paths and on-disk encodings comparable", () => {
    const a = normaliseKey("C:\\Dev\\myrepo-task");
    expect(normaliseKey("c--Dev-myrepo-task")).toBe(a);
    expect(normaliseKey("C--Dev-myrepo-task")).toBe(a);
  });
});

describe("classifyEntry", () => {
  it("treats a user turn as Claude owing a reply", () => {
    expect(classifyEntry({ type: "user", message: { role: "user", content: "hi" } })).toBe("working");
  });
  it("treats an assistant turn with tool calls as working", () => {
    expect(
      classifyEntry({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }),
    ).toBe("working");
  });
  it("treats an assistant text turn as awaiting input", () => {
    expect(
      classifyEntry({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    ).toBe("awaiting");
  });
  it("ignores non-conversational meta entries", () => {
    expect(classifyEntry({ type: "ai-title", aiTitle: "x" })).toBeNull();
    expect(classifyEntry({ type: "last-prompt" })).toBeNull();
  });
});

describe("NativeSessionWatcher.activityFor", () => {
  let home: string;
  let projectDir: string;
  const worktree = "C:/Temp/myrepo-task";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-native-"));
    projectDir = path.join(home, ".claude", "projects", "c--Temp-myrepo-task");
    fs.mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(mtimeMs: number, lastEntry = "{}"): void {
    const file = path.join(projectDir, "session.jsonl");
    fs.writeFileSync(file, lastEntry + "\n");
    const seconds = mtimeMs / 1000;
    fs.utimesSync(file, seconds, seconds);
  }

  it("reports 'working' for a freshly written transcript", () => {
    const now = 1_000_000_000_000;
    writeTranscript(now - 2_000);
    const w = new NativeSessionWatcher(home, noopLogger, () => now);
    w.ensure(worktree);
    expect(w.activityFor(worktree)).toBe("working");
  });

  it("reports 'working' during a thinking pause (last entry is a user turn)", () => {
    const now = 1_000_000_000_000;
    // Written 30s ago (past the fresh window, within the stall window): Claude owes a reply.
    writeTranscript(now - 30_000, JSON.stringify({ type: "user", message: { content: "go" } }));
    const w = new NativeSessionWatcher(home, noopLogger, () => now);
    w.ensure(worktree);
    expect(w.activityFor(worktree)).toBe("working");
  });

  it("stops reporting 'working' once writes stall (window likely closed mid-turn)", () => {
    const now = 1_000_000_000_000;
    // Owed a reply but nothing written for 3 minutes → treat as gone, not working.
    writeTranscript(now - 3 * 60_000, JSON.stringify({ type: "user", message: { content: "go" } }));
    const w = new NativeSessionWatcher(home, noopLogger, () => now);
    w.ensure(worktree);
    expect(w.activityFor(worktree)).toBeUndefined();
  });

  it("reports 'input-required' when the last entry is an assistant text turn", () => {
    const now = 1_000_000_000_000;
    writeTranscript(
      now - 60_000,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    );
    const w = new NativeSessionWatcher(home, noopLogger, () => now);
    w.ensure(worktree);
    expect(w.activityFor(worktree)).toBe("input-required");
  });

  it("ignores trailing meta entries when classifying", () => {
    const now = 1_000_000_000_000;
    const lines = [
      JSON.stringify({ type: "user", message: { content: "go" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "Task" }),
    ].join("\n");
    writeTranscript(now - 30_000, lines);
    const w = new NativeSessionWatcher(home, noopLogger, () => now);
    w.ensure(worktree);
    expect(w.activityFor(worktree)).toBe("working");
  });

  it("reports nothing for a stale transcript", () => {
    const now = 1_000_000_000_000;
    writeTranscript(now - 10 * 60_000); // 10 min ago, unknown last entry
    const w = new NativeSessionWatcher(home, noopLogger, () => now);
    w.ensure(worktree);
    expect(w.activityFor(worktree)).toBeUndefined();
  });

  it("reports nothing when no transcript folder exists", () => {
    const now = 1_000_000_000_000;
    const w = new NativeSessionWatcher(home, noopLogger, () => now);
    w.ensure("C:/Temp/other-task");
    expect(w.activityFor("C:/Temp/other-task")).toBeUndefined();
  });
});
