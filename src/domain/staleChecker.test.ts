import { describe, expect, it } from "vitest";
import {
  missingCheckerNote,
  rootNamedPaths,
  staleCheckerNote,
  staleCheckers,
} from "./staleChecker";

const VERIFY =
  'powershell.exe -NoProfile -File "${repoRoot}/tools/sql/Test-DeployedObjectMatchesRepo.ps1" ' +
  '-RepoRoot "${worktreePath}" -ChangedSince DEV -Environment dev';

describe("rootNamedPaths", () => {
  it("reads the script a check names through the placeholder", () => {
    expect(rootNamedPaths(VERIFY)).toEqual([
      "tools/sql/Test-DeployedObjectMatchesRepo.ps1",
    ]);
  });

  it("ignores a bare placeholder, which names the subject and not the script", () => {
    expect(rootNamedPaths('script.ps1 -RepoRoot "${repoRoot}"')).toEqual([]);
  });

  it("takes no path from a command that does not use the placeholder", () => {
    expect(rootNamedPaths("npm test")).toEqual([]);
  });

  it("normalises separators and the leading slash", () => {
    expect(rootNamedPaths('x "${repoRoot}\\tools\\git\\Test.ps1"')).toEqual([
      "tools/git/Test.ps1",
    ]);
  });

  it("reads every script a command names, once each", () => {
    const command = "${repoRoot}/a.ps1 && ${repoRoot}/b.ps1 && ${repoRoot}/a.ps1";
    expect(rootNamedPaths(command)).toEqual(["a.ps1", "b.ps1"]);
  });
});

describe("staleCheckers", () => {
  it("names the check the branch has changed", () => {
    expect(
      staleCheckers(VERIFY, [
        "tools/sql/Test-DeployedObjectMatchesRepo.ps1",
        "tools/sql/manufacturers/nissande/ppm/StoredProcedures/x.sql",
      ]),
    ).toEqual(["tools/sql/Test-DeployedObjectMatchesRepo.ps1"]);
  });

  it("says nothing when the branch touched only its own work", () => {
    expect(staleCheckers(VERIFY, ["tools/sql/manufacturers/x.sql"])).toEqual([]);
  });

  it("compares case-insensitively, with either separator", () => {
    expect(
      staleCheckers(VERIFY, [
        "Tools\\SQL\\Test-DeployedObjectMatchesRepo.ps1",
      ]),
    ).toEqual(["tools/sql/Test-DeployedObjectMatchesRepo.ps1"]);
  });

  it("does not read a changed file as staling a directory argument", () => {
    // `-RepoRoot "${repoRoot}"` names the subject, and every branch changes something
    // under the root. Treating that as a stale checker would fire on every failure.
    expect(
      staleCheckers('x.ps1 -RepoRoot "${repoRoot}"', ["tools/sql/x.sql"]),
    ).toEqual([]);
  });

  it("does not treat a named directory as covering the files beneath it", () => {
    expect(
      staleCheckers('x "${repoRoot}/tools/sql"', ["tools/sql/Runner.ps1"]),
    ).toEqual([]);
  });
});

describe("staleCheckerNote", () => {
  it("is absent when nothing is stale", () => {
    expect(staleCheckerNote([], "DEV")).toBeUndefined();
  });

  it("names the base branch, the file, and the remedy that is not available", () => {
    const note = staleCheckerNote(["tools/sql/Test.ps1"], "DEV")!;
    expect(note).toContain("DEV copy of `tools/sql/Test.ps1`");
    expect(note).toContain("Land the change");
    // The obvious move defeats the check, so the note has to say so.
    expect(note).toContain("running the worktree's copy is not the remedy");
  });

  it("reads as plural for more than one", () => {
    const note = staleCheckerNote(["a.ps1", "b.ps1"], "main")!;
    expect(note).toContain("changed those files");
  });
});

describe("missingCheckerNote", () => {
  it("is absent when the branch has every root-named script", () => {
    expect(missingCheckerNote([], "DEV")).toBeUndefined();
  });

  it("says the check is unaffected and the documentation beside it is not", () => {
    const note = missingCheckerNote(["tools/e2e/Invoke-SiteChecks.ps1"], "DEV")!;
    expect(note).toContain("DEV copy of `tools/e2e/Invoke-SiteChecks.ps1`");
    // Nothing here is a claim about the check, which runs the authoritative copy.
    expect(note).toContain("The check itself is unaffected");
    // The damage, and the only reason the note exists.
    expect(note).toContain("reaches it as silence");
    expect(note).toContain("Merge DEV into this branch");
  });

  it("reads as plural for more than one", () => {
    const note = missingCheckerNote(["a.ps1", "b.ps1"], "main")!;
    expect(note).toContain("those paths");
    expect(note).toContain("beside* them");
  });
});
