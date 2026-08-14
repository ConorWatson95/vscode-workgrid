import { describe, expect, it } from "vitest";
import { pathNamedInCommands } from "./claimEvidence";

describe("pathNamedInCommands", () => {
  it("finds a path a command spelt with other separators or case", () => {
    const commands = ["cd /c/Dev/Worktrees/PROMOTE-2792 && git push"];
    expect(pathNamedInCommands("C:\\Dev\\worktrees\\promote-2792", commands)).toBe(true);
  });

  it("finds a path a command wrote relatively", () => {
    expect(pathNamedInCommands("C:/Dev/promote-2792", ["git -C ../promote-2792 status"])).toBe(
      true,
    );
  });

  it("does not find a worktree no command mentions", () => {
    expect(
      pathNamedInCommands("C:/Dev/qube-live-sm", ["git status", "git log origin/DEV"]),
    ).toBe(false);
  });

  it("finds nothing in no commands", () => {
    expect(pathNamedInCommands("C:/Dev/promote-2792", [])).toBe(false);
  });
});
