import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTranscriptTitle, fallbackTitle } from "./transcriptReader";

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
