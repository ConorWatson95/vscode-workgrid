import { describe, expect, it } from "vitest";
import { resolveSiblingLinkPlan } from "./siblingLinkPlan";

const REPO = "C:\\Dev\\qubeautoapp";
const WORKTREE = "C:\\Dev\\worktrees\\qubeautoapp-fix-thing";

describe("resolveSiblingLinkPlan", () => {
  it("places the link beside the worktree, not inside it", () => {
    const plan = resolveSiblingLinkPlan(["C:\\Dev\\qubedata"], REPO, WORKTREE);
    expect(plan.problems).toEqual([]);
    expect(plan.operations).toEqual([
      {
        linkPath: "C:\\Dev\\worktrees\\qubedata",
        targetPath: "C:\\Dev\\qubedata",
        label: "C:\\Dev\\qubedata",
      },
    ]);
  });

  // The name the reference spells is not always the folder the repo was cloned into.
  it("takes an explicit name when the target folder is spelt differently", () => {
    const plan = resolveSiblingLinkPlan(
      [{ name: "QubeUtils", target: "C:\\Dev\\qube-utils-c" }],
      REPO,
      WORKTREE,
    );
    expect(plan.operations[0].linkPath).toBe("C:\\Dev\\worktrees\\QubeUtils");
    expect(plan.operations[0].targetPath).toBe("C:\\Dev\\qube-utils-c");
  });

  it("resolves a relative target against the repository root", () => {
    const plan = resolveSiblingLinkPlan(["..\\qubedata"], REPO, WORKTREE);
    expect(plan.operations[0].targetPath).toBe("C:\\Dev\\qubedata");
  });

  // This runs with whatever rights the editor has, so a name that is really a path
  // would place a link anywhere on the machine.
  it("rejects a name that is not a single folder name", () => {
    const plan = resolveSiblingLinkPlan(
      [
        { name: "..\\..\\Windows", target: "C:\\Dev\\qubedata" },
        { name: "a/b", target: "C:\\Dev\\qubedata" },
        { name: "..", target: "C:\\Dev\\qubedata" },
      ],
      REPO,
      WORKTREE,
    );
    expect(plan.operations).toEqual([]);
    expect(plan.problems).toHaveLength(3);
    expect(plan.problems[0]).toContain("single folder name");
  });

  it("rejects an entry with no target", () => {
    const plan = resolveSiblingLinkPlan(["   ", { target: "" }], REPO, WORKTREE);
    expect(plan.operations).toEqual([]);
    expect(plan.problems).toHaveLength(2);
  });

  it("keeps only the first entry for a link name", () => {
    const plan = resolveSiblingLinkPlan(
      ["C:\\Dev\\qubedata", { name: "QubeData", target: "C:\\Elsewhere\\qubedata" }],
      REPO,
      WORKTREE,
    );
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].targetPath).toBe("C:\\Dev\\qubedata");
    expect(plan.problems[0]).toContain("already linked");
  });

  // A link pointing at its own location is a loop, and tools that walk the tree
  // do not survive it.
  it("refuses a link whose target is the link itself", () => {
    const plan = resolveSiblingLinkPlan(
      ["C:\\Dev\\worktrees\\qubedata"],
      REPO,
      WORKTREE,
    );
    expect(plan.operations).toEqual([]);
    expect(plan.problems[0]).toContain("the same path");
  });

  it("plans nothing when nothing is configured", () => {
    const plan = resolveSiblingLinkPlan([], REPO, WORKTREE);
    expect(plan).toEqual({ operations: [], problems: [] });
  });
});
