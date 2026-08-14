import { describe, expect, it } from "vitest";
import { substitutePlaceholders } from "./commandPlaceholders";

const VALUES = {
  taskName: "NMGB-2792",
  branch: "feature/NMGB-2792-ev-share",
  baseBranch: "DEV",
  worktreePath: "C:/repos/app-NMGB-2792",
  repoRoot: "C:/Dev/qubeautoapp",
};

describe("${repoRoot}", () => {
  it("lets a check name its own script from the root", () => {
    // The command runs with the worktree as cwd, so a relative path runs the branch's
    // copy. A task branch cut before two fixes to a promotion check ran the old one and
    // failed on a bug already fixed on DEV, reporting the fixed behaviour's own message.
    const result = substitutePlaceholders(
      'powershell.exe -File "${repoRoot}/tools/git/Test-WorkPromoted.ps1"',
      VALUES,
    );
    expect(result.command).toBe(
      'powershell.exe -File "C:/Dev/qubeautoapp/tools/git/Test-WorkPromoted.ps1"',
    );
    expect(result.used).toEqual(["repoRoot"]);
  });

  it("is distinct from the worktree, which is what makes it worth having", () => {
    const result = substitutePlaceholders("${repoRoot} ${worktreePath}", VALUES);
    expect(result.command).toBe("C:/Dev/qubeautoapp C:/repos/app-NMGB-2792");
  });
});

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
    expect(result).toEqual({ command: "dotnet build", used: [], unknown: [], missing: [] });
  });

  it("substitutes a ticket when the task has one", () => {
    const result = substitutePlaceholders('-Ticket "${ticket}"', {
      ...VALUES,
      ticket: "NMGB-2534",
    });
    expect(result.command).toBe('-Ticket "NMGB-2534"');
    expect(result.used).toEqual(["ticket"]);
    expect(result.missing).toEqual([]);
  });

  it("leaves a known placeholder verbatim when nothing establishes a value", () => {
    // Blanking it would silently unscope a check whose entire value is being scoped —
    // and `Test-WorkPromoted.ps1` fails on an empty ticket anyway, saying only that
    // something was empty. Left verbatim, the failure names its own cause.
    const result = substitutePlaceholders('-Ticket "${ticket}"', VALUES);
    expect(result.command).toBe('-Ticket "${ticket}"');
    expect(result.missing).toEqual(["ticket"]);
    expect(result.used).toEqual([]);
    // Not "unknown": the remedies are opposites, and an unknown name usually needs
    // nothing done at all.
    expect(result.unknown).toEqual([]);
  });
});
