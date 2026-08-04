import { describe, expect, it } from "vitest";
import { filterMcpConfig } from "./mcpConfigFilter";

const config = JSON.stringify({
  mcpServers: {
    "qube-core-db": { command: "powershell.exe", args: ["-File", "start.ps1"] },
    "qube-sftp": { command: "powershell.exe", args: ["-File", "sftp.ps1"] },
    atlassian: { type: "http", url: "https://example.invalid/mcp" },
  },
});

describe("filterMcpConfig", () => {
  it("keeps only the named servers", () => {
    const result = filterMcpConfig(config, ["atlassian"]);
    expect(result?.kept).toEqual(["atlassian"]);
    expect(result?.dropped).toEqual(["qube-core-db", "qube-sftp"]);
    expect(Object.keys(JSON.parse(result!.json).mcpServers)).toEqual(["atlassian"]);
  });

  it("preserves a kept server's definition exactly", () => {
    const result = filterMcpConfig(config, ["atlassian"]);
    expect(JSON.parse(result!.json).mcpServers.atlassian).toEqual({
      type: "http",
      url: "https://example.invalid/mcp",
    });
  });

  it("matches names case-insensitively and ignores padding", () => {
    const result = filterMcpConfig(config, ["  ATLASSIAN  "]);
    expect(result?.kept).toEqual(["atlassian"]);
  });

  it("does nothing for an empty allow-list, which means no opinion", () => {
    // Not "run with no servers" — that would strip every stage's tools the
    // moment the setting was left at its default.
    expect(filterMcpConfig(config, [])).toBeUndefined();
    expect(filterMcpConfig(config, ["   "])).toBeUndefined();
  });

  it("does nothing when no named server exists, since that is likelier a typo", () => {
    expect(filterMcpConfig(config, ["atlasian"])).toBeUndefined();
  });

  it("understands the `servers` key as well as `mcpServers`", () => {
    const alternative = JSON.stringify({ servers: { a: { command: "x" }, b: { command: "y" } } });
    const result = filterMcpConfig(alternative, ["a"]);
    expect(result?.kept).toEqual(["a"]);
    expect(Object.keys(JSON.parse(result!.json).servers)).toEqual(["a"]);
  });

  it("preserves top-level keys it does not understand", () => {
    const withExtras = JSON.stringify({
      $schema: "https://example.invalid/schema.json",
      mcpServers: { a: { command: "x" }, b: { command: "y" } },
      somethingElse: { keep: true },
    });
    const parsed = JSON.parse(filterMcpConfig(withExtras, ["a"])!.json);
    expect(parsed.$schema).toBe("https://example.invalid/schema.json");
    expect(parsed.somethingElse).toEqual({ keep: true });
  });

  it("falls back rather than throwing on unusable input", () => {
    expect(filterMcpConfig("{ not json", ["a"])).toBeUndefined();
    expect(filterMcpConfig("[]", ["a"])).toBeUndefined();
    expect(filterMcpConfig('"a string"', ["a"])).toBeUndefined();
    expect(filterMcpConfig("{}", ["a"])).toBeUndefined();
    expect(filterMcpConfig('{"mcpServers": []}', ["a"])).toBeUndefined();
  });

  it("ends with a newline so the file behaves in a terminal", () => {
    expect(filterMcpConfig(config, ["atlassian"])!.json.endsWith("\n")).toBe(true);
  });
});
