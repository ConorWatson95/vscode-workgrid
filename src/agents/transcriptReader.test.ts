import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTranscriptTitle, fallbackTitle, loadItemsFromFile } from "./transcriptReader";

describe("loadItemsFromFile", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-load-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const say = (text: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

  it("reads a small transcript whole", () => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, [say("one"), say("two")].join("\n") + "\n");
    expect(loadItemsFromFile(file)).toEqual([
      { kind: "assistant", text: "one" },
      { kind: "assistant", text: "two" },
    ]);
  });

  it("keeps the most recent turns from a transcript far larger than the read cap", () => {
    // Transcripts reach tens of MB; reading one whole froze the extension host.
    const file = path.join(dir, "big.jsonl");
    const padding = "x".repeat(20_000);
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(say(`${padding}-${i}`));
    lines.push(say("the last thing said"));
    fs.writeFileSync(file, lines.join("\n") + "\n");
    expect(fs.statSync(file).size).toBeGreaterThan(4 * 1024 * 1024);

    const items = loadItemsFromFile(file);
    expect(items.length).toBeGreaterThan(0);
    expect(items[items.length - 1]).toEqual({ kind: "assistant", text: "the last thing said" });
  });

  it("drops the partial leading line rather than yielding half-parsed JSON", () => {
    // Every surviving entry must be intact — a truncated head must be discarded.
    const file = path.join(dir, "big.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(say("y".repeat(20_000) + `-${i}`));
    fs.writeFileSync(file, lines.join("\n") + "\n");

    for (const item of loadItemsFromFile(file)) {
      expect(item.kind).toBe("assistant");
      expect((item as { text: string }).text).toMatch(/^y+-\d+$/);
    }
  });

  it("returns empty for a missing file", () => {
    expect(loadItemsFromFile(path.join(dir, "nope.jsonl"))).toEqual([]);
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
