import { describe, expect, it } from "vitest";
import { parseBranchCreation, mayRecordBaseCommit } from "./baseCommitProposal";

// The real thing, from NMGB-2533's branch. Newest first, as git prints it.
const REAL = [
  "82132f3a2f0c4d5e6a7b8c9d0e1f2a3b4c5d6e7f\tcommit: Declare OrderHistoryLines.cshtml",
  "d267029520a717ec3406ff663f6d0655d9a3efce\tcommit: split S/N/O labour codes to Other",
  "7fe00c7e8c64e8abb392570373447ba4387385fe\tbranch: Created from DEV",
].join("\n");

describe("parseBranchCreation", () => {
  it("finds the commit a branch was cut from", () => {
    expect(parseBranchCreation(REAL)).toEqual({
      commit: "7fe00c7e8c64e8abb392570373447ba4387385fe",
      createdFrom: "DEV",
    });
  });

  // Sampled across four in-flight tasks, one had a reflog whose creation entry had been
  // trimmed away and one had no reflog at all. Absence is an ordinary answer here, not
  // an error, which is what makes this a proposal rather than a backfill.
  it("returns nothing when the creation entry has been trimmed", () => {
    const trimmed = [
      "aaaaaaa\tcommit: later work",
      "bbbbbbb\treset: moving to bbbbbbb",
      "ccccccc\tstoring head",
    ].join("\n");
    expect(parseBranchCreation(trimmed)).toBeUndefined();
  });

  // A branch with no reflog makes git print usage text to stderr. It reaches here as
  // ordinary lines that match nothing, so there is no special case to get wrong.
  it("treats git's own error text as no answer", () => {
    const noise = "Use '--' to separate paths from revisions, like this:\n'git <command>'";
    expect(parseBranchCreation(noise)).toBeUndefined();
  });

  // Newest first is load-bearing: a branch deleted and cut again has an older entry
  // describing a lineage this task never had, and enumerating from it would demand
  // commits that were never this task's.
  it("takes the most recent creation when a branch was cut twice", () => {
    const recreated = [
      "1111111111111111111111111111111111111111\tbranch: Created from DEV",
      "2222222222222222222222222222222222222222\tcommit: work on the old lineage",
      "3333333333333333333333333333333333333333\tbranch: Created from UAT",
    ].join("\n");
    expect(parseBranchCreation(recreated)?.commit).toBe(
      "1111111111111111111111111111111111111111",
    );
  });

  it("reads a creation from somewhere other than the task's base branch", () => {
    // Reported, never refused. A mismatch is exactly when recovering this by hand is
    // hardest, so withholding the answer there would be the wrong way round.
    const other = "4444444444444444444444444444444444444444\tbranch: Created from origin/UAT";
    expect(parseBranchCreation(other)?.createdFrom).toBe("origin/UAT");
  });
});

describe("mayRecordBaseCommit", () => {
  it("allows a proposed ancestor on a task that has none", () => {
    expect(
      mayRecordBaseCommit({ candidate: "7fe00c7e8", ancestor: true }),
    ).toBeUndefined();
  });

  // The same rule origin linking follows: a task quietly moved from one base to another
  // is a change nobody could see afterwards.
  it("refuses to overwrite one already recorded", () => {
    expect(
      mayRecordBaseCommit({ existing: "aaaa", candidate: "bbbb", ancestor: true }),
    ).toBe("already-recorded");
  });

  // The check that makes a typo harmless. `rev-list <branch> ^<non-ancestor>` does not
  // fail; it returns the branch's whole history, which is the enumeration this field
  // exists to make exact.
  it("refuses a commit that is not on the branch", () => {
    expect(mayRecordBaseCommit({ candidate: "bbbb", ancestor: false })).toBe(
      "not-an-ancestor",
    );
  });

  it("says so when the reflog proposed nothing", () => {
    expect(mayRecordBaseCommit({ ancestor: false })).toBe("not-in-reflog");
  });
});
