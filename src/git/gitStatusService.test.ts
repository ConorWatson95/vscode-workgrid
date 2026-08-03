import { describe, it, expect } from "vitest";
import {
  parseStatusPorcelain,
  parseBranchHeader,
  parseShortStat,
  mergeChangedPaths,
} from "./gitStatusService";

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
