import { describe, expect, it } from "vitest";
import { looksHarnessProvisioned, planOrphanSweep } from "./orphanSweep";

describe("looksHarnessProvisioned", () => {
  const repo = "C:/Dev/qubeautoapp";
  const parent = "C:/Dev/worktrees";
  const check = (p: string) => looksHarnessProvisioned(p, repo, parent);

  it("recognises a worktree the provisioner would have made", () => {
    expect(check("C:/Dev/worktrees/qubeautoapp-nissan-gb-data-load-navigator")).toBe(true);
  });

  // Every one of these was deleted by a sweep that trusted the orphan list, and every one
  // is a standing release or publish checkout the next promotion needs.
  it.each([
    "C:/Dev/release-RU-525-live",
    "C:/Dev/release-nojira-aftersales-sm",
    "C:/Dev/wt-imt-uat",
    "C:/Dev/qube-publish-sm",
  ])("does not recognise %s, which lives outside the configured parent", (p) => {
    expect(check(p)).toBe(false);
  });

  it.each(["C:/Dev/worktrees/live-props", "C:/Dev/worktrees/qube-p2799-cache"])(
    "does not recognise %s, which is in the parent but not named for the repository",
    (p) => {
      expect(check(p)).toBe(false);
    },
  );

  it("matches case-insensitively and across separators", () => {
    expect(looksHarnessProvisioned("c:\\dev\\worktrees\\QUBEAUTOAPP-task", repo, parent)).toBe(
      true,
    );
  });

  it("requires the separator, so a longer repository name cannot be claimed", () => {
    expect(looksHarnessProvisioned("C:/Dev/worktrees/qubeautoapp-x", "C:/Dev/qube", parent)).toBe(
      false,
    );
  });

  // Nested deeper means something other than the provisioner put it there.
  it("does not recognise a worktree nested below the parent", () => {
    expect(check("C:/Dev/worktrees/nested/qubeautoapp-task")).toBe(false);
  });

  it("does not recognise the repository itself", () => {
    expect(check("C:/Dev/qubeautoapp")).toBe(false);
  });
});

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
