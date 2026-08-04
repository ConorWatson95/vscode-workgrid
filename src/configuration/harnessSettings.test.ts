import { describe, expect, it } from "vitest";
import { HarnessSettings, recordSettingsReader } from "./harnessSettings";

function settings(values: Record<string, unknown> = {}): HarnessSettings {
  return new HarnessSettings(recordSettingsReader(values));
}

describe("HarnessSettings defaults", () => {
  const defaults = settings();

  it("supplies a default for every setting a route depends on", () => {
    expect(defaults.claudeCommand()).toBe("claude");
    expect(defaults.gateInterpreter()).toBe("node");
    expect(defaults.agentMode()).toBe("native");
    expect(defaults.permissionMode()).toBe("acceptEdits");
    expect(defaults.contextStrategy()).toBe("compact");
    expect(defaults.projectDocsPath()).toBe("docs/");
    expect(defaults.mcpConfigPath()).toBe(".mcp.json");
    expect(defaults.stageTimeoutMinutes()).toBe(45);
    expect(defaults.permissionWaitMinutes()).toBe(15);
    expect(defaults.compactPromptThreshold()).toBe(120000);
    expect(defaults.autoCompactThreshold()).toBe(0);
  });

  it("defaults the permission gate to holding refusals, not to passing them", () => {
    expect(defaults.pauseOnPermissionDenial()).toBe(true);
    expect(defaults.interactivePermissions()).toBe(true);
    // Off: the gate holds only what the CLI already refused, so it never has to
    // replicate the CLI's idea of a safe command.
    expect(defaults.holdEveryToolCall()).toBe(false);
  });

  it("gates a fixed tool list rather than everything", () => {
    expect(defaults.gatedTools()).toEqual([
      "Bash",
      "PowerShell",
      "Write",
      "Edit",
      "NotebookEdit",
    ]);
  });

  it("leaves location settings empty so callers use their conventional path", () => {
    expect(defaults.worktreeParentDir()).toBe("");
    expect(defaults.defaultBaseBranch()).toBe("");
    expect(defaults.reviewRulesPath()).toBe("");
    expect(defaults.harnessConfigPath()).toBe("");
    expect(defaults.model()).toBe("");
    expect(defaults.copyIntoWorktree()).toEqual([]);
  });

  it("supplies branch prefixes", () => {
    expect(settings().branchPrefixes()).toContain("feature");
    expect(settings().branchPrefixes()).toContain("chore");
  });
});

describe("HarnessSettings normalisation", () => {
  it("trims text settings", () => {
    expect(settings({ defaultBaseBranch: "  main  " }).defaultBaseBranch()).toBe("main");
  });

  it("falls back when a command is blanked out rather than running nothing", () => {
    expect(settings({ claudeCommand: "   " }).claudeCommand()).toBe("claude");
    expect(settings({ gateInterpreter: "" }).gateInterpreter()).toBe("node");
  });

  it("treats a blanked-out docs path as disabling the guidance", () => {
    // Distinct from an absent setting, which means "use docs/".
    expect(settings({ projectDocsPath: "  " }).projectDocsPath()).toBe("");
  });

  it("replaces an empty list with the defaults instead of gating nothing", () => {
    expect(settings({ gatedTools: [] }).gatedTools()).toContain("Bash");
    expect(settings({ branchPrefixes: [] }).branchPrefixes()).toContain("feature");
  });

  it("drops blank entries from lists", () => {
    expect(settings({ gatedTools: ["Bash", "  ", "", " Edit "] }).gatedTools()).toEqual([
      "Bash",
      "Edit",
    ]);
  });

  it("rejects a non-positive timeout, because a cap that fires instantly fails stages", () => {
    expect(settings({ stageTimeoutMinutes: 0 }).stageTimeoutMinutes()).toBe(45);
    expect(settings({ stageTimeoutMinutes: -5 }).stageTimeoutMinutes()).toBe(45);
    expect(settings({ permissionWaitMinutes: 0 }).permissionWaitMinutes()).toBe(15);
  });

  it("rejects a non-finite timeout", () => {
    expect(settings({ stageTimeoutMinutes: Number.NaN }).stageTimeoutMinutes()).toBe(45);
    expect(
      settings({ permissionWaitMinutes: Number.POSITIVE_INFINITY }).permissionWaitMinutes(),
    ).toBe(15);
  });

  it("keeps a valid override", () => {
    expect(settings({ stageTimeoutMinutes: 90 }).stageTimeoutMinutes()).toBe(90);
    expect(settings({ holdEveryToolCall: true }).holdEveryToolCall()).toBe(true);
    expect(settings({ pauseOnPermissionDenial: false }).pauseOnPermissionDenial()).toBe(
      false,
    );
  });

  it("survives a setting of the wrong type rather than propagating it", () => {
    expect(settings({ claudeCommand: 42 }).claudeCommand()).toBe("claude");
    expect(settings({ gatedTools: "Bash" }).gatedTools()).toContain("Bash");
    expect(settings({ copyIntoWorktree: "nope" }).copyIntoWorktree()).toEqual([]);
    expect(settings({ trackNativeActivity: "yes" }).trackNativeActivity()).toBe(true);
  });
});

describe("harnessConfigPath", () => {
  it("prefers its own setting", () => {
    const s = settings({
      harnessConfigPath: "config/harness.json",
      reviewRulesPath: "config/rules.json",
    });
    expect(s.harnessConfigPath()).toBe("config/harness.json");
  });

  it("defers to the older reviewRulesPath so existing config keeps working", () => {
    expect(settings({ reviewRulesPath: "config/rules.json" }).harnessConfigPath()).toBe(
      "config/rules.json",
    );
  });
});

describe("recordSettingsReader", () => {
  it("treats null like absent, so a cleared setting takes the default", () => {
    expect(settings({ claudeCommand: null }).claudeCommand()).toBe("claude");
  });
});
