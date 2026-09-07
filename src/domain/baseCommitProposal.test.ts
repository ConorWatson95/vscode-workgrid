import { describe, expect, it } from "vitest";
import {
  parseBranchCreation,
  mayRecordBaseCommit,
  foreignReferences,
} from "./baseCommitProposal";

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

describe("foreignReferences", () => {
  // The live case. `feature/renaultgb-myrewards-summary` yielded 103 commits from its
  // fork point, spanning six other tickets -- proof the proposal had swept in work the
  // task never did, and the signal that makes a bad proposal obvious in the dialog.
  it("names other tickets found among the commits", () => {
    const result = foreignReferences(
      [
        "a1 NMGB-2533 - the task's own work",
        "b2 RU-550 - somebody else's promotion",
        "c3 NMGB-2814 - another ticket entirely",
      ],
      "NMGB-2533",
    );
    expect(result.refs).toEqual(["RU-550", "NMGB-2814"]);
    expect(result.commits).toBe(2);
  });

  // 75 of those 103 commits carried no reference at all, so filtering on the convention
  // would have discarded three quarters of the set. A commit with no ref is not
  // evidence of anything, which is why this warns and never filters.
  it("says nothing about a commit that names no ticket", () => {
    const result = foreignReferences(
      ["a1 Write down that shared project files are cherry-picked", "b2 fix a typo"],
      "NMGB-2533",
    );
    expect(result).toEqual({ refs: [], commits: 0 });
  });

  it("ignores the task's own ref however it is cased", () => {
    expect(
      foreignReferences(["a1 nmgb-2533 - lower case in the subject"], "NMGB-2533").refs,
    ).toEqual([]);
  });

  // Leading every commit with a ticket key is one repository's convention. A project
  // whose refs look nothing like that supplies its own pattern, and gets no warning
  // rather than a wrong one.
  it("uses the project's own pattern when it declares one", () => {
    const result = foreignReferences(
      ["a1 #4417 the task's own", "b2 #9001 another piece of work"],
      "#4417",
      /#[0-9]+/,
    );
    expect(result.refs).toEqual(["#9001"]);
  });

  it("warns on every commit even when the task has no ref of its own", () => {
    // A task linked to nothing still benefits: any ref at all is a ref this task
    // cannot be shown to own.
    expect(foreignReferences(["a1 RU-550 - work"], undefined).commits).toBe(1);
  });
});
