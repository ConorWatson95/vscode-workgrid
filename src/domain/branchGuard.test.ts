import { describe, expect, it } from "vitest";
import { branchMismatch } from "./branchGuard";

describe("branchMismatch", () => {
  it("reports nothing when the worktree is where it should be", () => {
    expect(branchMismatch("feature/reman-date", "feature/reman-date")).toBeUndefined();
  });

  it("ignores the refs/heads prefix and case", () => {
    expect(
      branchMismatch("feature/reman-date", "refs/heads/Feature/Reman-Date"),
    ).toBeUndefined();
  });

  it("reports a mismatch, naming both branches and the fix", () => {
    const mismatch = branchMismatch("feature/reman-date", "LIVE_MultiMarket");
    expect(mismatch?.actual).toBe("LIVE_MultiMarket");
    expect(mismatch?.intended).toBe("feature/reman-date");
    expect(mismatch?.message).toContain("git checkout feature/reman-date");
  });

  it("says that an absence would look like a finding", () => {
    // The reported symptom: a migration review checked out another branch, found no
    // migration scripts, and said so truthfully about the wrong tree.
    expect(branchMismatch("feature/x", "main")?.message).toContain(
      "no migration scripts",
    );
  });

  it("recognises a detached HEAD as its own case", () => {
    const detached = branchMismatch("feature/x", "a1b2c3d");
    expect(detached?.message).toContain("detached HEAD");
    expect(branchMismatch("feature/x", "HEAD")?.message).toContain("detached HEAD");
  });

  it("treats an unknown branch as not a mismatch", () => {
    // A git call that returned nothing is a different problem from being on the
    // wrong branch, and stranding the task for it would be unexplainable.
    expect(branchMismatch("feature/x", undefined)).toBeUndefined();
    expect(branchMismatch("feature/x", "  ")).toBeUndefined();
  });

  it("treats an unrecorded intent as not a mismatch", () => {
    // A task created before the field existed is backfilled, not blocked.
    expect(branchMismatch(undefined, "main")).toBeUndefined();
  });
});
