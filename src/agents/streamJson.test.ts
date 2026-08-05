import { describe, it, expect } from "vitest";
import {
  parseStreamLine,
  toChatItems,
  sessionIdOf,
  modelOf,
  shortModelName,
  rateLimitOf,
  costUsdOf,
  isTurnComplete,
  summariseToolInput,
  encodeUserMessage,
  contextTokensOf,
  sessionTokensOf,
  compactInfoOf,
  mcpServersOf,
} from "./streamJson";

describe("sessionTokensOf", () => {
  it("reads the cumulative top-level usage on a result event", () => {
    expect(
      sessionTokensOf({
        type: "result",
        usage: {
          input_tokens: 1200,
          output_tokens: 3400,
          cache_read_input_tokens: 98000,
          cache_creation_input_tokens: 5600,
        },
      }),
    ).toEqual({ input: 1200, output: 3400, cacheRead: 98000, cacheCreation: 5600 });
  });

  it("ignores message.usage, which is one turn's context and not a total", () => {
    // The trap this function exists to avoid: the same field names in the other
    // place. Reading them here would report a per-turn snapshot as a run total.
    expect(
      sessionTokensOf({
        type: "result",
        message: { usage: { input_tokens: 999, output_tokens: 999 } },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for events that are not a result", () => {
    expect(
      sessionTokensOf({ type: "assistant", usage: { input_tokens: 50 } }),
    ).toBeUndefined();
  });

  it("treats an all-zero usage as no measurement", () => {
    expect(
      sessionTokensOf({ type: "result", usage: { input_tokens: 0, output_tokens: 0 } }),
    ).toBeUndefined();
  });

  it("does not double-count with contextTokensOf, which reads the other field", () => {
    const event = {
      type: "result",
      usage: { input_tokens: 4_000_000, cache_read_input_tokens: 1_000_000 },
      message: { usage: { input_tokens: 60_000, cache_read_input_tokens: 70_000 } },
    };
    // 130k of context, 5m of cumulative spend — the two must not be confusable.
    expect(contextTokensOf(event)).toBe(130_000);
    expect(sessionTokensOf(event)?.input).toBe(4_000_000);
  });
});

describe("compactInfoOf", () => {
  it("recognises a compact_boundary and reads pre_tokens", () => {
    const event = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 52000, trigger: "manual" },
    };
    expect(compactInfoOf(event)).toEqual({ preTokens: 52000 });
  });
  it("reads the camelCase metadata the saved transcript uses", () => {
    // Verbatim shape from a real ~/.claude/projects transcript.
    const event = {
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "manual", preTokens: 473867, postTokens: 14500 },
    };
    expect(compactInfoOf(event)).toEqual({ preTokens: 473867, postTokens: 14500 });
  });
  it("returns undefined for non-compaction events", () => {
    expect(compactInfoOf({ type: "system", subtype: "init" })).toBeUndefined();
    expect(compactInfoOf({ type: "assistant" })).toBeUndefined();
  });
});

describe("compact entries on replay", () => {
  it("suppresses the injected /compact summary instead of showing it as a user turn", () => {
    // A real compacted transcript: type "user", isCompactSummary true, and
    // notably NOT isMeta — so it has to be recognised on its own.
    const event = {
      type: "user",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation…",
      },
    };
    expect(toChatItems(event, true)).toEqual([]);
  });

  it("marks the boundary where history was cut", () => {
    const event = {
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 473867, postTokens: 14500 },
    };
    expect(toChatItems(event, true)).toEqual([
      { kind: "system", text: "Context compacted — 474k → 15k tokens" },
    ]);
  });

  it("still shows nothing for other system events", () => {
    expect(toChatItems({ type: "system", subtype: "init", model: "x" }, true)).toEqual([]);
  });

  it("collapses the /compact invocation and drops its local output", () => {
    const invocation = {
      type: "user",
      message: { role: "user", content: "<command-name>/compact</command-name><command-message>compact</command-message>" },
    };
    const output = {
      type: "user",
      message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
    };
    expect(toChatItems(invocation, true)).toEqual([{ kind: "user", text: "/compact" }]);
    expect(toChatItems(output, true)).toEqual([]);
  });
});

describe("contextTokensOf", () => {
  it("sums input, cache-read and cache-creation tokens from a message", () => {
    const event = { message: { usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 32000 } } };
    expect(contextTokensOf(event)).toBe(33002);
  });
  it("ignores the cumulative usage on a result event", () => {
    // A result event totals every turn in the run. Reading it reported 3.8M
    // tokens for a session whose real peak was 133k, so every turn tripped the
    // auto-compaction threshold and paid for a pointless compaction.
    const result = {
      type: "result",
      usage: { input_tokens: 5, cache_read_input_tokens: 3_800_000 },
    } as { message?: { usage?: { input_tokens?: number } } };
    expect(contextTokensOf(result)).toBeUndefined();
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

describe("modelOf / shortModelName", () => {
  it("extracts the resolved model from init", () => {
    expect(modelOf({ type: "system", subtype: "init", model: "claude-opus-5[1m]" }))
      .toBe("claude-opus-5[1m]");
  });
  it("ignores non-init events", () => {
    expect(modelOf({ type: "assistant", model: "claude-opus-5" })).toBeUndefined();
    expect(modelOf({ type: "system", subtype: "compact_boundary" })).toBeUndefined();
  });
  it("is undefined when init carries no model", () => {
    expect(modelOf({ type: "system", subtype: "init" })).toBeUndefined();
  });
  it("trims the vendor prefix for display", () => {
    expect(shortModelName("claude-opus-5[1m]")).toBe("opus-5[1m]");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5-20251001");
    // Leaves an already-short or unexpected name alone.
    expect(shortModelName("opus-5")).toBe("opus-5");
  });
});

describe("rateLimitOf / costUsdOf", () => {
  // Payload copied verbatim from a real stream.
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1785150000,
      rateLimitType: "five_hour",
      overageStatus: "allowed",
      isUsingOverage: false,
    },
  };

  it("reads a real rate_limit_event", () => {
    expect(rateLimitOf(event)).toEqual({
      status: "allowed",
      windowType: "five_hour",
      // Converted from the CLI's epoch *seconds* to milliseconds.
      resetsAtMs: 1785150000_000,
      isUsingOverage: false,
    });
  });

  it("ignores other event types and missing info", () => {
    expect(rateLimitOf({ type: "assistant" })).toBeUndefined();
    expect(rateLimitOf({ type: "rate_limit_event" })).toBeUndefined();
  });

  it("defaults unreported fields rather than throwing", () => {
    const r = rateLimitOf({ type: "rate_limit_event", rate_limit_info: {} });
    expect(r).toEqual({
      status: "unknown",
      windowType: "unknown",
      resetsAtMs: undefined,
      isUsingOverage: false,
    });
  });

  it("flags overage", () => {
    const r = rateLimitOf({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", isUsingOverage: true },
    });
    expect(r?.isUsingOverage).toBe(true);
  });

  it("reads cost only from result events", () => {
    expect(costUsdOf({ type: "result", total_cost_usd: 0.0953135 })).toBeCloseTo(0.0953135);
    expect(costUsdOf({ type: "assistant", total_cost_usd: 1 })).toBeUndefined();
    expect(costUsdOf({ type: "result" })).toBeUndefined();
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
      {
        kind: "tool",
        name: "Edit",
        detail: "src/a.ts",
        // The uncapped copy the stage report reads; `detail` is for a chat row.
        detailFull: "src/a.ts",
        id: undefined,
      },
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
      {
        kind: "tool-result",
        text: "ok",
        // Unflattened copy, so a multi-line listing keeps its lines in a report.
        textFull: "ok",
        isError: false,
        callId: undefined,
      },
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

describe("mcpServersOf", () => {
  it("reads the servers and their statuses from an init event", () => {
    const event = {
      type: "system",
      subtype: "init",
      mcp_servers: [
        { name: "jira", status: "connected" },
        { name: "sftp", status: "failed" },
      ],
    };
    expect(mcpServersOf(event)).toEqual([
      { name: "jira", status: "connected" },
      { name: "sftp", status: "failed" },
    ]);
  });

  it("ignores events that are not init", () => {
    expect(mcpServersOf({ type: "assistant" })).toBeUndefined();
    expect(
      mcpServersOf({ type: "system", subtype: "compact_boundary" }),
    ).toBeUndefined();
  });

  it("returns undefined when the CLI reported no server list", () => {
    expect(mcpServersOf({ type: "system", subtype: "init" })).toBeUndefined();
  });

  it("returns an empty list when the config had no servers", () => {
    expect(
      mcpServersOf({ type: "system", subtype: "init", mcp_servers: [] }),
    ).toEqual([]);
  });

  it("names a server whose status the CLI omitted rather than dropping it", () => {
    // A server with no status still cost startup time, so it must be reported.
    expect(
      mcpServersOf({ type: "system", subtype: "init", mcp_servers: [{ name: "x" }] }),
    ).toEqual([{ name: "x", status: "unknown" }]);
  });

  it("skips entries with no usable name", () => {
    const event = {
      type: "system",
      subtype: "init",
      mcp_servers: [{ status: "connected" }, null, "nope", { name: "ok" }],
    };
    expect(mcpServersOf(event)).toEqual([{ name: "ok", status: "unknown" }]);
  });
});
