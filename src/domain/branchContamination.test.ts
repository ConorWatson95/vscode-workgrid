import { describe, expect, it } from "vitest";
import {
  contaminationNote,
  distinctiveLines,
  unattributedPaths,
} from "./branchContamination";

const PROC = "tools/sql/manufacturers/nissangb/trade/StoredProcedures/dbo.sp_TradeCampaigns.StoredProcedure.sql";
const DETAIL = "tools/sql/manufacturers/nissangb/trade/StoredProcedures/dbo.p_CardCampaign_Detail.StoredProcedure.sql";

describe("unattributedPaths", () => {
  it("matches an absolute recorded write against a repo-relative changed path", () => {
    expect(
      unattributedPaths([PROC, DETAIL], [`C:/Dev/worktrees/task/${DETAIL}`]),
    ).toEqual([PROC]);
  });

  it("matches across separators and case", () => {
    expect(
      unattributedPaths([DETAIL], [`C:\\Dev\\worktrees\\task\\${DETAIL.replace(/\//g, "\\").toUpperCase()}`]),
    ).toEqual([]);
  });

  it("does not let one file attribute another with the same basename", () => {
    expect(unattributedPaths(["docs/README.md"], ["tools/README.md"])).toEqual([
      "docs/README.md",
    ]);
  });

  it("requires a segment boundary, so a suffix of a name does not match", () => {
    expect(unattributedPaths(["src/a.ts"], ["/repo/extra-src/a.ts"])).toEqual(["src/a.ts"]);
  });

  it("returns everything when nothing was recorded — the live case", () => {
    expect(unattributedPaths([PROC, DETAIL], [])).toEqual([PROC, DETAIL]);
  });
});

describe("distinctiveLines", () => {
  it("keeps the line that identified the real contaminating commit", () => {
    const added = [
      "BEGIN",
      "\tIF @ConflictGroupId IS NOT NULL",
      "\t\t\tAND tc.ConflictGroupId = @ConflictGroupId",
    ];
    expect(distinctiveLines(added)).toContain("IF @ConflictGroupId IS NOT NULL");
  });

  it("drops delimiters, short lines and lines with no word in them", () => {
    expect(distinctiveLines(["BEGIN", "END", "))", "\t", "-- ok"])).toEqual([]);
    expect(distinctiveLines(["============================================"])).toEqual([]);
  });

  it("keeps comments, because a contaminating change brings its own", () => {
    const comment = "-- Love2Shop overlap suppression is handled inline using CampaignPriority.";
    expect(distinctiveLines([comment])).toEqual([comment]);
  });

  it("de-duplicates and caps", () => {
    const line = (n: number) => `SELECT something_quite_distinctive_${n} FROM dbo.Table`;
    const added = [line(1), line(1), line(2), line(3), line(4), line(5), line(6)];
    expect(distinctiveLines(added)).toHaveLength(5);
    expect(distinctiveLines(added, 2)).toEqual([line(1), line(2)]);
  });
});

describe("contaminationNote", () => {
  it("says nothing when nothing was confirmed", () => {
    expect(contaminationNote([])).toBeUndefined();
  });

  it("names the commit, because that is the diagnosis", () => {
    const note = contaminationNote([
      {
        path: PROC,
        commits: [{ sha: "d2ffbaf7c1234", subject: "NMGB-2832 - suppress an overlapping campaign" }],
      },
    ]);
    expect(note).toContain("d2ffbaf7c");
    expect(note).toContain("NMGB-2832");
    expect(note).toContain(PROC);
    expect(note).toMatch(/A file in this branch's diff/);
  });

  it("pluralises and lists each file", () => {
    const note = contaminationNote([
      { path: PROC, commits: [{ sha: "aaaaaaaaa", subject: "one" }] },
      { path: DETAIL, commits: [{ sha: "bbbbbbbbb", subject: "two" }] },
    ]);
    expect(note).toMatch(/2 files in this branch's diff/);
    expect(note).toContain(DETAIL);
  });
});
