import { describe, it, expect } from "vitest";
import {
  parseStreamLine,
  toChatItems,
  sessionIdOf,
  isTurnComplete,
  summariseToolInput,
  encodeUserMessage,
  contextTokensOf,
} from "./streamJson";

describe("contextTokensOf", () => {
  it("sums input, cache-read and cache-creation tokens from a message", () => {
    const event = { message: { usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 32000 } } };
    expect(contextTokensOf(event)).toBe(33002);
  });
  it("reads top-level usage on result events", () => {
    expect(contextTokensOf({ usage: { input_tokens: 5, cache_read_input_tokens: 40000 } })).toBe(40005);
  });
  it("returns undefined when there is no usage", () => {
    expect(contextTokensOf({ message: {} })).toBeUndefined();
  });
});

describe("parseStreamLine", () => {
  it("parses a JSON line", () => {
    expect(parseStreamLine('{"type":"system"}')).toEqual({ type: "system" });
  });
  it("returns null for blank or malformed lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
    expect(parseStreamLine("{not json")).toBeNull();
  });
});

describe("sessionIdOf / isTurnComplete", () => {
  it("extracts session id from init", () => {
    expect(sessionIdOf({ type: "system", subtype: "init", session_id: "abc" })).toBe("abc");
    expect(sessionIdOf({ type: "assistant" })).toBeUndefined();
  });
  it("detects a result event", () => {
    expect(isTurnComplete({ type: "result" })).toBe(true);
    expect(isTurnComplete({ type: "assistant" })).toBe(false);
  });
});

describe("toChatItems", () => {
  it("renders assistant text and tool use", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it." },
          { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
        ],
      },
    };
    const items = toChatItems(event);
    expect(items).toEqual([
      { kind: "assistant", text: "Working on it." },
      { kind: "tool", name: "Edit", detail: "src/a.ts" },
    ]);
  });

  it("includes the user's typed turn only when replaying a transcript", () => {
    const stringMsg = { type: "user", message: { role: "user", content: "/init" } };
    const arrayMsg = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
    };
    // Live stream: user text is not rendered (we render it ourselves).
    expect(toChatItems(stringMsg)).toEqual([]);
    // Transcript replay: user text becomes a user bubble.
    expect(toChatItems(stringMsg, true)).toEqual([{ kind: "user", text: "/init" }]);
    expect(toChatItems(arrayMsg, true)).toEqual([{ kind: "user", text: "Fix the bug" }]);
  });

  it("collapses a slash-command invocation to just the command", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: "<command-message>init</command-message> <command-name>/init</command-name> <command-args></command-args>",
      },
    };
    expect(toChatItems(event, true)).toEqual([{ kind: "user", text: "/init" }]);
  });

  it("skips isMeta entries (e.g. the expanded command prompt)", () => {
    const event = {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "Please analyze this codebase and create a CLAUDE.md…" },
    };
    expect(toChatItems(event, true)).toEqual([]);
  });

  it("strips injected wrapper tags from user text", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: "<ide_opened_file>The user opened Untitled-2</ide_opened_file>",
      },
    };
    expect(toChatItems(event, true)).toEqual([]);
  });

  it("renders tool results from user events", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "ok", is_error: false }],
      },
    };
    expect(toChatItems(event)).toEqual([
      { kind: "tool-result", text: "ok", isError: false },
    ]);
  });

  it("surfaces a result event only when it is an error", () => {
    expect(toChatItems({ type: "result", is_error: false, result: "done" })).toEqual([]);
    const errItems = toChatItems({ type: "result", is_error: true, result: "boom" });
    expect(errItems).toEqual([{ kind: "result", text: "boom", isError: true }]);
  });

  it("ignores system events", () => {
    expect(toChatItems({ type: "system", subtype: "init" })).toEqual([]);
  });
});

describe("summariseToolInput", () => {
  it("prefers command/file_path fields", () => {
    expect(summariseToolInput({ command: "npm test" })).toBe("npm test");
    expect(summariseToolInput({ file_path: "a/b.ts" })).toBe("a/b.ts");
  });
  it("truncates long values", () => {
    const long = "x".repeat(200);
    expect(summariseToolInput({ command: long })?.endsWith("…")).toBe(true);
  });
});

describe("encodeUserMessage", () => {
  it("produces a newline-terminated user message", () => {
    const line = encodeUserMessage("hello");
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  });
});
