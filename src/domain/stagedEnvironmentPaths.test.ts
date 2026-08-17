import { describe, expect, it } from "vitest";
import {
  environmentStagingReason,
  findEnvironmentStaging,
  namesPathExplicitly,
  stagesInBulk,
} from "./stagedEnvironmentPaths";
import { WorktreeChange } from "./worktreeDiscard";

const WEB_CONFIG = "QubeAutoApp/Web.config";
const PATTERNS = [WEB_CONFIG, "bin/Debug/"];

/** Modified in the working tree and not staged — the case the rule is about. */
function dirty(path: string): WorktreeChange {
  return { path, index: " ", worktree: "M" };
}

describe("stagesInBulk", () => {
  it("catches the flag forms", () => {
    expect(stagesInBulk("git add -A")).toBe(true);
    expect(stagesInBulk("git add --all")).toBe(true);
    expect(stagesInBulk("git add -u")).toBe(true);
    expect(stagesInBulk("git add --update")).toBe(true);
  });

  it("catches the pathspec forms an agent actually types", () => {
    expect(stagesInBulk("git add .")).toBe(true);
    expect(stagesInBulk("git add :/")).toBe(true);
    expect(stagesInBulk("git add *")).toBe(true);
  });

  it("catches a combined short flag", () => {
    expect(stagesInBulk("git add -Av")).toBe(true);
    expect(stagesInBulk('git commit -am "work"')).toBe(true);
  });

  it("catches -a on a commit, which bypasses the index entirely", () => {
    expect(stagesInBulk('git commit -a -m "work"')).toBe(true);
    expect(stagesInBulk('git commit --all -m "work"')).toBe(true);
  });

  it("leaves a plain commit alone, because the index already passed this rule", () => {
    expect(stagesInBulk('git commit -m "work"')).toBe(false);
    expect(stagesInBulk("git commit")).toBe(false);
  });

  it("leaves staging by name alone", () => {
    expect(stagesInBulk("git add SqlProject/RU-550.sql")).toBe(false);
    expect(stagesInBulk(`git add ${WEB_CONFIG}`)).toBe(false);
  });

  it("is not fooled by an unrelated command carrying the same letters", () => {
    expect(stagesInBulk("git status")).toBe(false);
    expect(stagesInBulk("git log --all")).toBe(false);
    expect(stagesInBulk("npm add -A")).toBe(false);
    // The `-m` here is a message, not a sweep.
    expect(stagesInBulk('git commit -m "add all the things"')).toBe(false);
  });

  it("survives a global flag before the subcommand", () => {
    expect(stagesInBulk("git -C /repo add -A")).toBe(true);
    expect(stagesInBulk("git --no-pager add .")).toBe(true);
  });
});

describe("namesPathExplicitly", () => {
  it("matches however a shell spells the path", () => {
    for (const command of [
      `git add ${WEB_CONFIG}`,
      "git add QubeAutoApp\\Web.config",
      "git add ./Web.config",
      'git add "QubeAutoApp/Web.config"',
    ]) {
      expect(namesPathExplicitly(command, WEB_CONFIG)).toBe(true);
    }
  });

  it("does not match a different file that merely starts the same", () => {
    expect(namesPathExplicitly("git add Web.config.bak", WEB_CONFIG)).toBe(false);
    expect(namesPathExplicitly("git add MyWeb.config", WEB_CONFIG)).toBe(false);
  });
});

describe("findEnvironmentStaging", () => {
  it("refuses a sweep that would carry a declared path", () => {
    const staging = findEnvironmentStaging({
      command: "git add -A",
      patterns: PATTERNS,
      changes: [dirty("SqlProject/RU-550.sql"), dirty(WEB_CONFIG)],
    });
    expect(staging?.paths).toEqual([WEB_CONFIG]);
  });

  it("matches a directory pattern at any segment boundary", () => {
    const staging = findEnvironmentStaging({
      command: 'git commit -am "work"',
      patterns: PATTERNS,
      changes: [dirty("QubeAutoApp.Mapping.Data/bin/Debug/Renci.SshNet.xml")],
    });
    expect(staging?.paths).toEqual([
      "QubeAutoApp.Mapping.Data/bin/Debug/Renci.SshNet.xml",
    ]);
  });

  it("passes a sweep when nothing declared is dirty", () => {
    expect(
      findEnvironmentStaging({
        command: "git add -A",
        patterns: PATTERNS,
        changes: [dirty("SqlProject/RU-550.sql")],
      }),
    ).toBeUndefined();
  });

  it("passes when the project declares nothing", () => {
    expect(
      findEnvironmentStaging({
        command: "git add -A",
        patterns: [],
        changes: [dirty(WEB_CONFIG)],
      }),
    ).toBeUndefined();
  });

  it("passes a command that stages by name", () => {
    expect(
      findEnvironmentStaging({
        command: `git add ${WEB_CONFIG}`,
        patterns: PATTERNS,
        changes: [dirty(WEB_CONFIG)],
      }),
    ).toBeUndefined();
  });

  it("passes a sweep that names the declared path as its pathspec", () => {
    expect(
      findEnvironmentStaging({
        command: `git add -A ${WEB_CONFIG}`,
        patterns: PATTERNS,
        changes: [dirty(WEB_CONFIG)],
      }),
    ).toBeUndefined();
  });

  // The escape hatch `selectDiscardable` documents: staging is how a real change to one
  // of these files is kept. It must survive the commit as well as the add, or it is not
  // an escape hatch at all.
  it("passes a bulk commit when the declared path is already staged", () => {
    expect(
      findEnvironmentStaging({
        command: 'git commit -am "adds an appSettings key"',
        patterns: PATTERNS,
        changes: [{ path: WEB_CONFIG, index: "M", worktree: " " }],
      }),
    ).toBeUndefined();
  });

  it("still refuses when a declared path is staged and further modified", () => {
    const staging = findEnvironmentStaging({
      command: "git add -A",
      patterns: PATTERNS,
      changes: [{ path: WEB_CONFIG, index: "M", worktree: "M" }],
    });
    expect(staging?.paths).toEqual([WEB_CONFIG]);
  });

  it("refuses an untracked declared path, which a sweep would add", () => {
    const staging = findEnvironmentStaging({
      command: "git add .",
      patterns: PATTERNS,
      changes: [{ path: WEB_CONFIG, index: "?", worktree: "?" }],
    });
    expect(staging?.paths).toEqual([WEB_CONFIG]);
  });

  it("leaves a conflicted path alone, because a bulk add is how a merge is resolved", () => {
    expect(
      findEnvironmentStaging({
        command: "git add -A",
        patterns: PATTERNS,
        changes: [{ path: WEB_CONFIG, index: "U", worktree: "U" }],
      }),
    ).toBeUndefined();
  });
});

describe("environmentStagingReason", () => {
  it("names the paths and both compliant forms", () => {
    const reason = environmentStagingReason({ paths: [WEB_CONFIG] });
    expect(reason).toContain(WEB_CONFIG);
    expect(reason).toContain("by name");
    // Must say nothing has broken, or a denial reads as a permission wall and the stage
    // starts working around it — the failure the whole gate exists to prevent.
    expect(reason).toContain("Nothing");
    expect(reason).toContain("has gone wrong with your work");
  });
});
