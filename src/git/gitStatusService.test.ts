import { describe, it, expect } from "vitest";
import {
  parseStatusPorcelain,
  parseBranchHeader,
  parseShortStat,
  mergeChangedPaths,
  parseNameStatus,
  mergeChangedFiles,
} from "./gitStatusService";

describe("parseNameStatus", () => {
  it("pairs a status with its path", () => {
    expect(parseNameStatus("M\0src/a.ts\0A\0src/b.ts\0")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "src/b.ts" },
    ]);
  });

  it("consumes the extra field a rename carries", () => {
    // The third field is what makes this worth parsing: pairing fields off blindly
    // would read the new path as the next entry's status.
    expect(parseNameStatus("R100\0src/old.ts\0src/new.ts\0M\0src/c.ts\0")).toEqual([
      { status: "R", path: "src/new.ts", origin: "src/old.ts" },
      { status: "M", path: "src/c.ts" },
    ]);
  });

  it("normalises separators", () => {
    expect(parseNameStatus("M\0src\\Mapping\\Profile.cs\0")).toEqual([
      { status: "M", path: "src/Mapping/Profile.cs" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("\0")).toEqual([]);
  });

  it("ignores a trailing status with no path", () => {
    expect(parseNameStatus("M\0src/a.ts\0M\0")).toEqual([{ status: "M", path: "src/a.ts" }]);
  });
});

describe("mergeChangedFiles", () => {
  it("keeps a file added by a commit as added, not modified", () => {
    // The working-tree diff can show the same path as modified; taking that letter
    // would send the view looking for a before side that does not exist.
    expect(
      mergeChangedFiles([{ status: "A", path: "a.ts" }], [{ status: "M", path: "a.ts" }], ""),
    ).toEqual([{ path: "a.ts", status: "added" }]);
  });

  it("treats an untracked file as added", () => {
    expect(mergeChangedFiles([], [], "new.ts\0")).toEqual([
      { path: "new.ts", status: "added", untracked: true },
    ]);
  });

  it("reports a file deleted in the working tree as deleted", () => {
    expect(
      mergeChangedFiles([{ status: "M", path: "a.ts" }], [{ status: "D", path: "a.ts" }], ""),
    ).toEqual([{ path: "a.ts", status: "deleted" }]);
  });

  it("omits a file the task created and then removed", () => {
    // It is in neither the base nor the worktree, so there is nothing to compare.
    expect(
      mergeChangedFiles([{ status: "A", path: "a.ts" }], [{ status: "D", path: "a.ts" }], ""),
    ).toEqual([]);
  });

  it("carries a rename's origin through", () => {
    expect(
      mergeChangedFiles([{ status: "R", path: "new.ts", origin: "old.ts" }], [], ""),
    ).toEqual([{ path: "new.ts", status: "renamed", origin: "old.ts" }]);
  });

  it("counts a path in both diffs once, sorted", () => {
    expect(
      mergeChangedFiles(
        [{ status: "M", path: "z.ts" }],
        [{ status: "M", path: "z.ts" }, { status: "M", path: "a.ts" }],
        "",
      ),
    ).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "z.ts", status: "modified" },
    ]);
  });
});

describe("mergeChangedPaths", () => {
  it("merges NUL-separated outputs and drops empties", () => {
    expect(mergeChangedPaths(["a.ts\0b.ts\0", "", "c.ts\0"])).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("de-duplicates a file that is both committed and modified", () => {
    // One changed file, not two — inflated counts would mislead the
    // explanation shown to the user.
    expect(mergeChangedPaths(["src/a.ts\0", "src/a.ts\0"])).toEqual(["src/a.ts"]);
  });

  it("normalises separators so rules can be written one way", () => {
    expect(mergeChangedPaths(["src\\Mapping\\Profile.cs\0"])).toEqual([
      "src/Mapping/Profile.cs",
    ]);
  });

  it("sorts for stable output", () => {
    expect(mergeChangedPaths(["z.ts\0a.ts\0"])).toEqual(["a.ts", "z.ts"]);
  });

  it("returns nothing for empty output", () => {
    expect(mergeChangedPaths(["", "\0"])).toEqual([]);
  });
});

describe("parseStatusPorcelain", () => {
  it("reports a clean tree", () => {
    const out = "## main...origin/main\0";
    const status = parseStatusPorcelain(out);
    expect(status.isDirty).toBe(false);
    expect(status.changedFileCount).toBe(0);
    expect(status.branch).toBe("main");
  });

  it("counts modified, untracked and staged entries", () => {
    const out = ["## feature/x", " M src/a.ts", "?? new.txt", "A  src/b.ts"].join("\0") + "\0";
    const status = parseStatusPorcelain(out);
    expect(status.changedFileCount).toBe(3);
    expect(status.isDirty).toBe(true);
    expect(status.branch).toBe("feature/x");
  });

  it("skips the rename source path field", () => {
    // "R  new -> old" in -z mode: entry, then a separate NUL field for the source.
    const out = ["## main", "R  new.ts", "old.ts"].join("\0") + "\0";
    const status = parseStatusPorcelain(out);
    expect(status.changedFileCount).toBe(1);
  });
});

describe("parseBranchHeader", () => {
  it("extracts a branch name", () => {
    expect(parseBranchHeader("## main...origin/main")).toBe("main");
    expect(parseBranchHeader("## feature/x")).toBe("feature/x");
  });

  it("returns undefined for detached HEAD", () => {
    expect(parseBranchHeader("## HEAD (no branch)")).toBeUndefined();
  });
});

describe("parseShortStat", () => {
  it("parses files, insertions and deletions", () => {
    const s = parseShortStat(" 3 files changed, 12 insertions(+), 4 deletions(-)");
    expect(s).toEqual({ filesChanged: 3, insertions: 12, deletions: 4 });
  });

  it("handles a single file with only insertions", () => {
    const s = parseShortStat(" 1 file changed, 2 insertions(+)");
    expect(s).toEqual({ filesChanged: 1, insertions: 2, deletions: 0 });
  });

  it("returns zeros for empty output", () => {
    expect(parseShortStat("")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});
