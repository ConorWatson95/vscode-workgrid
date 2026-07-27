import { describe, it, expect } from "vitest";
import { parseUsageOutput, assistantTextOf } from "./planUsage";

/** Verbatim from a real `/usage` reply. */
const REAL_USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 1% used · resets Jul 27, 5pm (Europe/London)
Current week (all models): 27% used · resets Jul 30, 2pm (Europe/London)
Current week (Fable): 0% used

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 829 requests · 15 sessions
  59% of your usage was at >150k context
  32% of your usage came from subagent-heavy sessions`;

describe("parseUsageOutput", () => {
  it("extracts each limit window from real output", () => {
    const lines = parseUsageOutput(REAL_USAGE);
    expect(lines).toEqual([
      { label: "Current session", percent: 1, resets: "Jul 27, 5pm (Europe/London)" },
      { label: "Current week (all models)", percent: 27, resets: "Jul 30, 2pm (Europe/London)" },
      { label: "Current week (Fable)", percent: 0, resets: undefined },
    ]);
  });

  it("ignores the contributing-factors section", () => {
    // Those lines are "59% of your usage ..." — percentages, but not limits.
    const labels = parseUsageOutput(REAL_USAGE).map((l) => l.label);
    expect(labels.some((l) => l.includes("of your usage"))).toBe(false);
    expect(labels).toHaveLength(3);
  });

  it("returns empty rather than guessing when the format is unrecognised", () => {
    expect(parseUsageOutput("")).toEqual([]);
    expect(parseUsageOutput("Something went wrong.")).toEqual([]);
    expect(parseUsageOutput("Current week: unavailable")).toEqual([]);
  });

  it("rejects out-of-range percentages", () => {
    expect(parseUsageOutput("Bogus: 240% used")).toEqual([]);
  });

  it("handles a hyphen separator as well as the middle dot", () => {
    expect(parseUsageOutput("Current session: 5% used - resets tomorrow")).toEqual([
      { label: "Current session", percent: 5, resets: "tomorrow" },
    ]);
  });
});

describe("assistantTextOf", () => {
  it("pulls text out of a stream-json transcript", () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"x"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Current session: 3% used"}]}}',
      '{"type":"result","total_cost_usd":0}',
    ].join("\n");
    expect(assistantTextOf(stdout)).toBe("Current session: 3% used");
    expect(parseUsageOutput(assistantTextOf(stdout))).toHaveLength(1);
  });

  it("supports string content and ignores malformed lines", () => {
    const stdout = 'garbage\n{"type":"assistant","message":{"content":"plain text"}}';
    expect(assistantTextOf(stdout)).toBe("plain text");
  });

  it("returns empty when there is no assistant output", () => {
    expect(assistantTextOf('{"type":"result"}')).toBe("");
    expect(assistantTextOf("")).toBe("");
  });
});
