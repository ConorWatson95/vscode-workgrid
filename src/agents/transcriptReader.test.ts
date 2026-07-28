import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readTranscriptTitle,
  fallbackTitle,
  loadItemsFromFile,
  loadItemsFromFileSync,
} from "./transcriptReader";

describe("loadItemsFromFile", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-load-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const say = (text: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

  function write(name: string, lines: string[]): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  it("reads a small transcript whole", async () => {
    const file = write("s.jsonl", [say("one"), say("two")]);
    expect(await loadItemsFromFile(file)).toEqual([
      { kind: "assistant", text: "one" },
      { kind: "assistant", text: "two" },
    ]);
  });

  it("keeps a full-length real-world session rather than truncating it", async () => {
    // A real 3,600-entry session produced 2,040 items; a 300 cap dropped ~85%
    // of it, which is what read as history going missing.
    const file = write("long.jsonl", Array.from({ length: 2040 }, (_, i) => say(`turn ${i}`)));
    const items = await loadItemsFromFile(file);
    expect(items).toHaveLength(2040);
    expect(items[0]).toEqual({ kind: "assistant", text: "turn 0" });
  });

  it("says so when the item cap drops earlier messages", async () => {
    const file = write("over.jsonl", Array.from({ length: 12 }, (_, i) => say(`turn ${i}`)));
    const items = await loadItemsFromFile(file, 5);
    expect(items).toHaveLength(6); // 5 kept + the notice
    expect(items[0].kind).toBe("system");
    expect((items[0] as { text: string }).text).toContain("7 earlier messages not shown");
    expect(items[items.length - 1]).toEqual({ kind: "assistant", text: "turn 11" });
  });

  it("keeps the newest turns and never yields half-parsed JSON when byte-capped", async () => {
    // Exceeding the byte cap must discard the partial leading line intact.
    const file = write("big.jsonl", [
      ...Array.from({ length: 1500 }, (_, i) => say("y".repeat(20_000) + `-${i}`)),
      say("the last thing said"),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(24 * 1024 * 1024);

    const items = await loadItemsFromFile(file);
    expect(items[items.length - 1]).toEqual({ kind: "assistant", text: "the last thing said" });
    expect(items[0].kind).toBe("system"); // the truncation notice
    for (const item of items.slice(1)) {
      expect(item.kind).toBe("assistant");
      expect((item as { text: string }).text).toMatch(/^(y+-\d+|the last thing said)$/);
    }
  });

  it("does not replay entries the transcript repeats on resume", async () => {
    // Resuming re-appends earlier entries verbatim: same uuid, same timestamp.
    // A real 555-entry transcript had 196 such repeats, so the conversation's
    // opening messages rendered again partway through.
    const entry = (uuid: string, text: string) =>
      JSON.stringify({
        type: "assistant",
        uuid,
        timestamp: "2026-07-27T09:04:32.455Z",
        message: { content: [{ type: "text", text }] },
      });
    const file = write("resumed.jsonl", [
      entry("a", "first"),
      entry("b", "second"),
      entry("c", "third"),
      // The resume re-append, byte-identical to the entries above.
      entry("a", "first"),
      entry("b", "second"),
      entry("d", "fourth"),
    ]);
    expect(await loadItemsFromFile(file)).toEqual([
      { kind: "assistant", text: "first" },
      { kind: "assistant", text: "second" },
      { kind: "assistant", text: "third" },
      { kind: "assistant", text: "fourth" },
    ]);
  });

  it("keeps genuinely repeated messages that have their own uuid", async () => {
    // Identical text is not itself proof of a repeat — asking the same thing
    // twice must still show twice.
    const say2 = (uuid: string, text: string) =>
      JSON.stringify({ type: "user", uuid, message: { content: text } });
    const file = write("twice.jsonl", [say2("x", "run it again"), say2("y", "run it again")]);
    expect(await loadItemsFromFile(file)).toEqual([
      { kind: "user", text: "run it again" },
      { kind: "user", text: "run it again" },
    ]);
  });

  it("returns empty for a missing file", async () => {
    expect(await loadItemsFromFile(path.join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("the sync variant agrees with the async one", async () => {
    const file = write("both.jsonl", [say("one"), say("two"), say("three")]);
    expect(loadItemsFromFileSync(file)).toEqual(await loadItemsFromFile(file));
    expect(loadItemsFromFileSync(path.join(dir, "nope.jsonl"))).toEqual([]);
  });
});

describe("readTranscriptTitle", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-title-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(lines: object[]): string {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  it("prefers an ai-title", () => {
    const file = write([
      { type: "user", message: { content: "/init" } },
      { type: "ai-title", aiTitle: "Set up the project" },
    ]);
    expect(readTranscriptTitle(file)).toBe("Set up the project");
  });

  it("falls back to the first user prompt when there is no ai-title (e.g. /init)", () => {
    const file = write([
      { type: "user", message: { content: "/init" } },
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
    ]);
    expect(readTranscriptTitle(file)).toBe("/init");
  });

  it("reads the first user prompt from array content", () => {
    const file = write([
      { type: "user", message: { content: [{ type: "text", text: "Fix the export bug" }] } },
    ]);
    expect(readTranscriptTitle(file)).toBe("Fix the export bug");
  });

  it("returns undefined when nothing usable is present", () => {
    const file = write([{ type: "system", subtype: "init" }]);
    expect(readTranscriptTitle(file)).toBeUndefined();
  });
});

describe("fallbackTitle", () => {
  it("produces a short friendly label, not a raw GUID", () => {
    expect(fallbackTitle("11111111-1111-4111-8111-111111111111")).toBe("Session 11111111");
  });
});
