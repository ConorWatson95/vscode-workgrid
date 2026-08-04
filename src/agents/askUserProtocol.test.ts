import { describe, expect, it } from "vitest";
import {
  ASK_ABANDONED_RESULT,
  ASK_SERVER_NAME,
  ASK_TOOL_NAME,
  buildAskMcpConfig,
  formatAskResult,
  parseAskRequest,
} from "./askUserProtocol";

describe("tool naming", () => {
  it("matches the mcp__server__tool form the permission layer uses", () => {
    // Probed: the denial arrives as tool_name "mcp__taskworkspaces__ask_user",
    // so the allow rule has to be spelled exactly this way.
    expect(ASK_TOOL_NAME).toBe(`mcp__${ASK_SERVER_NAME}__ask_user`);
    expect(ASK_TOOL_NAME).toBe("mcp__taskworkspaces__ask_user");
  });
});

describe("parseAskRequest", () => {
  it("reads the questions and optional context", () => {
    const request = parseAskRequest(
      "a1",
      JSON.stringify({ questions: ["Which env?", "Which variant?"], context: "deploy" }),
    )!;
    expect(request).toEqual({
      id: "a1",
      questions: ["Which env?", "Which variant?"],
      context: "deploy",
    });
  });

  it("drops blank questions and trims the rest", () => {
    const request = parseAskRequest(
      "a1",
      JSON.stringify({ questions: ["  Which env?  ", "", "   "] }),
    )!;
    expect(request.questions).toEqual(["Which env?"]);
  });

  it("returns undefined rather than throwing on junk", () => {
    // A wedged stage is worse than an unanswered question.
    expect(parseAskRequest("a1", "not json")).toBeUndefined();
    expect(parseAskRequest("a1", "null")).toBeUndefined();
    expect(parseAskRequest("a1", JSON.stringify({ questions: [] }))).toBeUndefined();
    expect(parseAskRequest("a1", JSON.stringify({ questions: "one" }))).toBeUndefined();
  });

  it("omits context when it is absent or blank", () => {
    const request = parseAskRequest(
      "a1",
      JSON.stringify({ questions: ["Q"], context: "   " }),
    )!;
    expect(request.context).toBeUndefined();
  });
});

describe("formatAskResult", () => {
  it("pairs each answer with its question", () => {
    // A stage asks several at once, so an unlabelled list would be ambiguous.
    const text = formatAskResult(["Which env?", "Which variant?"], ["UAT", "NWE"]);
    expect(text).toContain("Q: Which env?\nA: UAT");
    expect(text).toContain("Q: Which variant?\nA: NWE");
  });

  it("says so when an answer is missing rather than pairing them wrongly", () => {
    const text = formatAskResult(["A?", "B?"], ["only this"]);
    expect(text).toContain("Q: A?\nA: only this");
    expect(text).toContain("Q: B?\nA: (no answer given)");
  });

  it("tells an abandoned agent to proceed and declare its assumptions", () => {
    // Otherwise a stopped task leaves the agent blocked until the tool timeout.
    expect(ASK_ABANDONED_RESULT).toMatch(/best judgement/i);
    expect(ASK_ABANDONED_RESULT).toMatch(/assumptions/i);
  });
});

describe("buildAskMcpConfig", () => {
  const config = () =>
    buildAskMcpConfig({
      interpreter: "node",
      serverPath: "C:/Users/Conor Watson/gates/t1/ask.js",
      inboxPath: "C:/Users/Conor Watson/gates/t1/questions",
    }) as any;

  it("names the server so its tool resolves to the expected id", () => {
    expect(Object.keys(config().mcpServers)).toEqual([ASK_SERVER_NAME]);
  });

  it("passes paths as argv rather than a shell string", () => {
    // No quoting is involved, which is what makes a path with spaces safe here —
    // unlike the hook command, which is shelled.
    const server = config().mcpServers[ASK_SERVER_NAME];
    expect(server.command).toBe("node");
    expect(server.args).toEqual([
      "C:/Users/Conor Watson/gates/t1/ask.js",
      "C:/Users/Conor Watson/gates/t1/questions",
    ]);
  });
});
