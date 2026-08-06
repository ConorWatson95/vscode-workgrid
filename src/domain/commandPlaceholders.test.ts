import { describe, expect, it } from "vitest";
import { substitutePlaceholders } from "./commandPlaceholders";

const VALUES = {
  taskName: "NMGB-2792",
  branch: "feature/NMGB-2792-ev-share",
  baseBranch: "DEV",
  worktreePath: "C:/repos/app-NMGB-2792",
};

describe("substitutePlaceholders", () => {
  it("substitutes every known placeholder", () => {
    const result = substitutePlaceholders(
      "./Test-PublishWorktreesReady.ps1 -Ticket \"${taskName}\" -Branch ${branch} -Base ${baseBranch} -Path ${worktreePath}",
      VALUES,
    );
    expect(result.command).toBe(
      './Test-PublishWorktreesReady.ps1 -Ticket "NMGB-2792" -Branch feature/NMGB-2792-ev-share -Base DEV -Path C:/repos/app-NMGB-2792',
    );
    expect(result.used).toEqual(["taskName", "branch", "baseBranch", "worktreePath"]);
    expect(result.unknown).toEqual([]);
  });

  it("leaves a shell variable exactly as written", () => {
    // ${...} is real syntax in both shells this runs under, so substituting or blanking
    // an unrecognised name would corrupt working commands to catch typos.
    const result = substitutePlaceholders('echo "${env:PATH}${HOME}"', VALUES);
    expect(result.command).toBe('echo "${env:PATH}${HOME}"');
    expect(result.unknown).toEqual(["HOME"]);
  });

  it("reports an unrecognised name once, however often it appears", () => {
    const result = substitutePlaceholders("${taskname} ${taskname}", VALUES);
    expect(result.unknown).toEqual(["taskname"]);
    expect(result.used).toEqual([]);
  });

  it("substitutes a placeholder used more than once", () => {
    const result = substitutePlaceholders("a ${taskName} b ${taskName}", VALUES);
    expect(result.command).toBe("a NMGB-2792 b NMGB-2792");
    expect(result.used).toEqual(["taskName"]);
  });

  it("leaves a command with no placeholders untouched", () => {
    const result = substitutePlaceholders("dotnet build", VALUES);
    expect(result).toEqual({ command: "dotnet build", used: [], unknown: [] });
  });
});
