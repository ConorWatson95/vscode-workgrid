import { describe, expect, it } from "vitest";
import {
  describeDiscard,
  matchesDiscardPattern,
  parsePorcelainChanges,
  selectDiscardable,
  WorktreeChange,
} from "./worktreeDiscard";

/** The nine paths from the real failure, in the codes git reported them under. */
const REAL_FAILURE = [
  " M QubeAutoApp.Mapping.Data/bin/Debug/QubeData.dll.config",
  " M QubeAutoApp.Mapping.Domain/bin/Debug/QubeData.dll.config",
  " M QubeAutoApp.MysteryShop.Data/bin/Debug/QubeData.dll.config",
  " M QubeAutoApp.MysteryShop.Domain/bin/Debug/QubeData.dll.config",
  " M QubeAutoApp.MysteryShop.Services/bin/Debug/AntiXssLibrary.xml",
  " M QubeAutoApp.MysteryShop.Services/bin/Debug/QubeData.dll.config",
  " M QubeAutoApp.MysteryShop.Services/bin/Debug/Renci.SshNet.Async.xml",
  " M QubeAutoApp.MysteryShop.Services/bin/Debug/Renci.SshNet.xml",
  " M QubeAutoApp/Web.config",
].join("\n");

const QUBE_PATTERNS = ["QubeAutoApp/Web.config", "bin/Debug/"];

const change = (
  path: string,
  index = " ",
  worktree = "M",
): WorktreeChange => ({ path, index, worktree });

describe("parsePorcelainChanges", () => {
  it("reads the status code and path of each entry", () => {
    const changes = parsePorcelainChanges(" M src/a.ts\n?? src/b.ts");
    expect(changes).toEqual([
      { path: "src/a.ts", index: " ", worktree: "M" },
      { path: "src/b.ts", index: "?", worktree: "?" },
    ]);
  });

  it("takes the destination of a rename, which is the file on disk", () => {
    expect(parsePorcelainChanges("R  old.ts -> new.ts")[0].path).toBe("new.ts");
  });

  it("drops a quoted path rather than guessing at its escapes", () => {
    // Guessing wrong here discards the wrong file, so uncertainty must not resolve
    // into an action.
    expect(parsePorcelainChanges(' M "odd\\nname.ts"')).toEqual([]);
  });
});

describe("matchesDiscardPattern", () => {
  it("matches a trailing-slash pattern at any segment boundary", () => {
    expect(matchesDiscardPattern("A.Data/bin/Debug/x.config", "bin/Debug/")).toBe(true);
    expect(matchesDiscardPattern("bin/Debug/x.config", "bin/Debug/")).toBe(true);
  });

  it("does not let a directory pattern match a partial segment", () => {
    // "mybin/Debug/" is a different directory, and matching it would discard files
    // nobody declared.
    expect(matchesDiscardPattern("mybin/Debug/x.config", "bin/Debug/")).toBe(false);
  });

  it("matches a pattern without a trailing slash exactly", () => {
    expect(matchesDiscardPattern("QubeAutoApp/Web.config", "QubeAutoApp/Web.config")).toBe(true);
    // The one that must not widen: another project's Web.config is not the declared one.
    expect(matchesDiscardPattern("Other/Web.config", "QubeAutoApp/Web.config")).toBe(false);
    expect(matchesDiscardPattern("QubeAutoApp/Web.config.bak", "QubeAutoApp/Web.config")).toBe(false);
  });

  it("compares case-insensitively, since these paths are compared on Windows", () => {
    expect(matchesDiscardPattern("QubeAutoApp/web.CONFIG", "QubeAutoApp/Web.config")).toBe(true);
  });
});

describe("selectDiscardable", () => {
  it("clears the whole of the real failure", () => {
    const selection = selectDiscardable(parsePorcelainChanges(REAL_FAILURE), QUBE_PATTERNS);
    expect(selection.discard).toHaveLength(9);
    expect(selection.withheld).toEqual([]);
  });

  it("leaves a path no pattern names", () => {
    const selection = selectDiscardable([change("src/work.ts")], QUBE_PATTERNS);
    expect(selection).toEqual({ discard: [], withheld: [] });
  });

  it("never discards an untracked file", () => {
    // Unrecoverable, and untracked is where new work lives.
    const selection = selectDiscardable(
      [change("QubeAutoApp/Web.config", "?", "?")],
      QUBE_PATTERNS,
    );
    expect(selection.discard).toEqual([]);
    expect(selection.withheld[0].reason).toMatch(/could not be undone/);
  });

  it("never discards a staged change", () => {
    const selection = selectDiscardable(
      [change("QubeAutoApp/Web.config", "M", " ")],
      QUBE_PATTERNS,
    );
    expect(selection.discard).toEqual([]);
    expect(selection.withheld[0].reason).toMatch(/deliberate/);
  });

  it("never discards a conflicted path", () => {
    const selection = selectDiscardable(
      [change("QubeAutoApp/Web.config", "U", "U")],
      QUBE_PATTERNS,
    );
    expect(selection.discard).toEqual([]);
    expect(selection.withheld[0].reason).toBe("conflicted");
  });

  it("discards nothing when the project declared nothing", () => {
    // No config means the old behaviour exactly.
    expect(selectDiscardable(parsePorcelainChanges(REAL_FAILURE), [])).toEqual({
      discard: [],
      withheld: [],
    });
  });
});

describe("describeDiscard", () => {
  it("names every path it discarded", () => {
    // The announcement is the safety margin: a real Web.config change removed in
    // silence is indistinguishable from one never made.
    const text = describeDiscard(selectDiscardable([change("QubeAutoApp/Web.config")], QUBE_PATTERNS));
    expect(text).toContain("QubeAutoApp/Web.config");
    expect(text).toContain("Discarded 1 local change(s)");
  });

  it("says why a declared path was kept, since the check will still fail on it", () => {
    const text = describeDiscard(
      selectDiscardable([change("QubeAutoApp/Web.config", "?", "?")], QUBE_PATTERNS),
    );
    expect(text).toMatch(/Kept QubeAutoApp\/Web.config/);
  });

  it("says nothing when nothing happened", () => {
    expect(describeDiscard({ discard: [], withheld: [] })).toBeUndefined();
  });
});
