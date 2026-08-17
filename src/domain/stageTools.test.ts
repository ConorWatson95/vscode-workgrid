import { describe, expect, it } from "vitest";
import { MEASURED_STAGE_TOOLS, stageTools } from "./stageTools";

describe("stageTools", () => {
  it("declares the tools stages were measured using", () => {
    expect(stageTools()).toEqual([
      "Bash",
      "Read",
      "Skill",
      "PowerShell",
      "Edit",
      "Grep",
      "Write",
      "ToolSearch",
      "Glob",
      "Agent",
      "TaskOutput",
    ]);
  });

  // The three the first, intuition-written list dropped. Each is cheap to lose by
  // accident and expensive to lose in practice, so each is pinned by name.
  it("keeps Skill, or a stage loses the protocol skill", () => {
    expect(stageTools()).toContain("Skill");
  });

  it("keeps Agent, because subagent fan-out is governed, not removed", () => {
    // `subagentLimits` bounds delegation by depth and concurrency. Dropping the tool
    // here would disable it entirely and silently, from the other direction.
    expect(stageTools()).toContain("Agent");
  });

  it("keeps ToolSearch, which is how a deferred tool is found at all", () => {
    expect(stageTools()).toContain("ToolSearch");
  });

  it("widens from configuration without restating the default", () => {
    expect(stageTools(["WebFetch"])).toContain("WebFetch");
    expect(stageTools(["WebFetch"])).toContain("Bash");
  });

  it("ignores blanks and does not duplicate a tool already declared", () => {
    const widened = stageTools(["  ", "bash", "WebFetch"]);
    expect(widened.filter((t) => t.toLowerCase() === "bash")).toHaveLength(1);
    expect(widened).not.toContain("  ");
  });

  it("records the share of sessions behind each entry", () => {
    // The comment is the evidence: an edit that drops a tool should have to argue
    // with a number rather than a hunch.
    for (const tool of MEASURED_STAGE_TOOLS) {
      expect(tool.sessionShare).toBeGreaterThan(0);
      expect(tool.sessionShare).toBeLessThanOrEqual(1);
    }
  });
});
