import { describe, it, expect } from "vitest";
import { parseUsageOutput, assistantTextOf, parseResetAt, formatResetIn } from "./planUsage";

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

describe("parseResetAt", () => {
  const now = new Date(2026, 6, 27, 13, 0).getTime(); // 27 Jul 2026, 1pm local

  it("reads the reset clause from real output", () => {
    expect(parseResetAt("Jul 27, 5pm (Europe/London)", now)).toBe(
      new Date(2026, 6, 27, 17, 0).getTime(),
    );
    expect(parseResetAt("Jul 30, 2pm (Europe/London)", now)).toBe(
      new Date(2026, 6, 30, 14, 0).getTime(),
    );
  });

  it("handles minutes, am, and 12am/12pm", () => {
    expect(parseResetAt("Jul 27, 9:30am", now)).toBe(new Date(2026, 6, 27, 9, 30).getTime());
    expect(parseResetAt("Jul 27, 12am", now)).toBe(new Date(2026, 6, 27, 0, 0).getTime());
    expect(parseResetAt("Jul 27, 12pm", now)).toBe(new Date(2026, 6, 27, 12, 0).getTime());
  });

  it("picks the year nearest now, so December wraps into January", () => {
    const dec = new Date(2026, 11, 31, 23, 0).getTime();
    expect(parseResetAt("Jan 1, 2am", dec)).toBe(new Date(2027, 0, 1, 2, 0).getTime());
  });

  it("returns undefined rather than inventing a time", () => {
    expect(parseResetAt("tomorrow", now)).toBeUndefined();
    expect(parseResetAt("Smarch 40, 2pm", now)).toBeUndefined();
    expect(parseResetAt("", now)).toBeUndefined();
  });
});

describe("formatResetIn", () => {
  const now = 1_000_000_000_000;
  const inMs = (ms: number) => formatResetIn(now + ms, now);

  it("uses days, hours and minutes like the Claude extension", () => {
    expect(inMs(2 * 86_400_000)).toBe("2 days");
    expect(inMs(7 * 3_600_000)).toBe("7 hrs");
    expect(inMs(45 * 60_000)).toBe("45 mins");
  });

  it("singularises", () => {
    expect(inMs(86_400_000)).toBe("1 day");
    expect(inMs(3_600_000)).toBe("1 hr");
    expect(inMs(60_000)).toBe("1 min");
  });

  it("reports elapsed windows as now", () => {
    expect(inMs(0)).toBe("now");
    expect(inMs(-5000)).toBe("now");
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
