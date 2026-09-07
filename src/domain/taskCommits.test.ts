import { describe, expect, it } from "vitest";
import { recordCommits, commitShas } from "./taskCommits";

const AT = "2026-09-07T15:00:00.000Z";

describe("recordCommits", () => {
  // rev-list prints newest first; the record reads oldest first, because that is the
  // order they were made in as far as anything here can know. Not sorted by date: a
  // commit's date is not its position on a branch, and re-sorting reorders a cherry-pick.
  it("records newly observed commits oldest first", () => {
    const result = recordCommits(undefined, ["newest", "middle", "oldest"], { at: AT });
    expect(commitShas(result)).toEqual(["oldest", "middle", "newest"]);
  });

  it("appends only what is new, keeping the original observation of the rest", () => {
    const first = recordCommits(undefined, ["a"], { at: AT, stageId: "s1" });
    const second = recordCommits(first, ["b", "a"], { at: "later", stageId: "s2" });
    expect(commitShas(second)).toEqual(["a", "b"]);
    expect(second[0]).toMatchObject({ commit: "a", at: AT, stageId: "s1" });
    expect(second[1]).toMatchObject({ commit: "b", at: "later", stageId: "s2" });
  });

  // Stage boundaries observe constantly and the state file is read-modify-write, so a
  // caller has to be able to tell "nothing happened" cheaply.
  it("returns the existing list unchanged when nothing is new", () => {
    const first = recordCommits(undefined, ["a"], { at: AT });
    const again = recordCommits(first, ["a"], { at: "later" });
    expect(again).toEqual(first);
  });

  // The rule that makes this useful at the moment it is asked. A promoted commit leaves
  // `rev-list <branch> ^<base>`, and removing it then would empty the set exactly when a
  // promotion check needs it -- which is the failure of asking git directly.
  it("never removes a commit that is no longer observed", () => {
    const first = recordCommits(undefined, ["a", "b"], { at: AT });
    const promoted = recordCommits(first, [], { at: "later" });
    expect(commitShas(promoted)).toEqual(["b", "a"]);
  });

  // A commit made by hand between advances has no stage. Recorded anyway: dropping it
  // to keep attribution tidy would reintroduce the incompleteness this exists to end.
  it("records an unattributed commit", () => {
    const result = recordCommits(undefined, ["a"], { at: AT });
    expect(result[0].stageId).toBeUndefined();
    expect(commitShas(result)).toEqual(["a"]);
  });

  it("ignores empty entries and a sha seen twice in one observation", () => {
    const result = recordCommits(undefined, ["a", "", "a"], { at: AT });
    expect(commitShas(result)).toEqual(["a"]);
  });
});

describe("commitShas", () => {
  it("is empty for a task that has recorded nothing", () => {
    expect(commitShas(undefined)).toEqual([]);
  });
});
