import { describe, expect, it } from "vitest";
import { planOrphanSweep } from "./orphanSweep";

describe("planOrphanSweep", () => {
  it("removes a clean worktree", () => {
    const sweep = planOrphanSweep([
      { path: "C:/Dev/worktrees/a", branch: "feature/a", changedFileCount: 0 },
    ]);
    expect(sweep.removable.map((o) => o.path)).toEqual(["C:/Dev/worktrees/a"]);
    expect(sweep.kept).toEqual([]);
  });

  it("keeps a worktree with uncommitted changes", () => {
    const sweep = planOrphanSweep([
      { path: "C:/Dev/worktrees/dirty", branch: "feature/d", changedFileCount: 3 },
    ]);
    expect(sweep.removable).toEqual([]);
    expect(sweep.kept.map((o) => o.path)).toEqual(["C:/Dev/worktrees/dirty"]);
  });

  // The rule that matters most: a git that could not be read is the one condition under
  // which defaulting the other way would delete the most.
  it("keeps a worktree whose status could not be read", () => {
    const sweep = planOrphanSweep([{ path: "C:/Dev/worktrees/unreadable" }]);
    expect(sweep.removable).toEqual([]);
    expect(sweep.kept.map((o) => o.path)).toEqual(["C:/Dev/worktrees/unreadable"]);
  });

  it("partitions a mixed list, keeping every entry in one side or the other", () => {
    const orphans = [
      { path: "clean-1", changedFileCount: 0 },
      { path: "dirty", changedFileCount: 1 },
      { path: "unreadable" },
      { path: "clean-2", changedFileCount: 0 },
    ];
    const sweep = planOrphanSweep(orphans);
    expect(sweep.removable.map((o) => o.path)).toEqual(["clean-1", "clean-2"]);
    expect(sweep.kept.map((o) => o.path)).toEqual(["dirty", "unreadable"]);
    expect(sweep.removable.length + sweep.kept.length).toBe(orphans.length);
  });

  it("has nothing to do with an empty list", () => {
    expect(planOrphanSweep([])).toEqual({ removable: [], kept: [] });
  });

  // A detached orphan is still removable: the branch is what a sweep never touches, and
  // there being none is not a reason to keep a checkout nobody owns.
  it("removes a clean detached worktree", () => {
    const sweep = planOrphanSweep([{ path: "detached", changedFileCount: 0 }]);
    expect(sweep.removable.map((o) => o.path)).toEqual(["detached"]);
  });
});
