import { describe, it, expect } from "vitest";
import {
  parseUsageOutput,
  assistantTextOf,
  parseResetAt,
  formatResetIn,
  parseContributors,
  tidyFactorLabel,
} from "./planUsage";

/** Verbatim from a real `/usage` reply, contributing-factors section included. */
const REAL_CONTRIBUTORS = `You are currently using your subscription to power your Claude Code usage

Current session: 32% used · resets Jul 27, 4:59pm (Europe/London)
Current week (all models): 30% used · resets Jul 30, 2pm (Europe/London)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 1240 requests · 16 sessions
  53% of your usage was at >150k context
  51% of your usage came from sessions active for 8+ hours
  29% of your usage was while 4+ sessions ran in parallel
  Top skills: /superpowers:subagent-driven-development 6%, /claude-api 2%
  Top plugins: superpowers 9%

Last 7d · 5586 requests · 42 sessions
  64% of your usage was at >150k context
  Top MCP servers: qube-sftp 1%, atlassian 1%`;

describe("parseContributors", () => {
  it("splits real output into reporting windows", () => {
    const periods = parseContributors(REAL_CONTRIBUTORS);
    expect(periods.map((p) => p.label)).toEqual(["Last 24h", "Last 7d"]);
    expect(periods[0].requests).toBe(1240);
    expect(periods[0].sessions).toBe(16);
    expect(periods[1].requests).toBe(5586);
  });

  it("reads the behaviour lines, shortening the sentence", () => {
    const [first] = parseContributors(REAL_CONTRIBUTORS);
    expect(first.factors).toEqual([
      { label: ">150k context", percent: 53 },
      { label: "sessions active for 8+ hours", percent: 51 },
      { label: "4+ sessions ran in parallel", percent: 29 },
    ]);
  });

  it("reads the ranked lists, keeping names intact", () => {
    const [first, second] = parseContributors(REAL_CONTRIBUTORS);
    expect(first.lists).toEqual([
      {
        kind: "skills",
        entries: [
          { name: "/superpowers:subagent-driven-development", percent: 6 },
          { name: "/claude-api", percent: 2 },
        ],
      },
      { kind: "plugins", entries: [{ name: "superpowers", percent: 9 }] },
    ]);
    expect(second.lists[0].kind).toBe("MCP servers");
  });

  it("does not confuse driver lines with limit windows", () => {
    // Both sections contain percentages; the limit parser must ignore these.
    const limits = parseUsageOutput(REAL_CONTRIBUTORS);
    expect(limits.map((l) => l.label)).toEqual([
      "Current session",
      "Current week (all models)",
    ]);
  });

  it("returns empty when the section is absent or unrecognised", () => {
    expect(parseContributors("Current session: 1% used")).toEqual([]);
    expect(parseContributors("")).toEqual([]);
  });

  it("ignores entries it cannot read rather than inventing them", () => {
    const periods = parseContributors(
      "Last 24h · 5 requests · 1 sessions\n  Top skills: broken, /ok 3%\n  240% of your usage was at nonsense",
    );
    expect(periods[0].lists[0].entries).toEqual([{ name: "/ok", percent: 3 }]);
    expect(periods[0].factors).toEqual([]);
  });
});

describe("tidyFactorLabel", () => {
  it("strips the sentence connectives the CLI uses", () => {
    expect(tidyFactorLabel("was at >150k context")).toBe(">150k context");
    expect(tidyFactorLabel("came from subagent-heavy sessions")).toBe("subagent-heavy sessions");
    expect(tidyFactorLabel("was while 4+ sessions ran in parallel")).toBe(
      "4+ sessions ran in parallel",
    );
  });

  it("leaves an already-short label alone", () => {
    expect(tidyFactorLabel("something new")).toBe("something new");
  });
});

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
