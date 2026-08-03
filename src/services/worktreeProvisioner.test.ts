import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveCopyPlan } from "../domain/worktreeCopyPlan";
import { CopyFileSystem, WorktreeProvisioner } from "./worktreeProvisioner";
import { Logger } from "../logging/logger";

const warnings: string[] = [];
const logger: Logger = {
  info: () => {},
  warn: (m) => warnings.push(m),
  error: () => {},
  debug: () => {},
};

const REPO = path.resolve("C:/repos/app");
const WORKTREE = path.resolve("C:/repos/app-t1");

/** In-memory filesystem recording the copies that were attempted. */
function fakeFs(
  present: string[],
  directories: string[] = [],
  failOn: string[] = [],
): CopyFileSystem & { copies: [string, string][]; dirs: string[] } {
  const normalise = (p: string) => path.resolve(p).toLowerCase();
  const set = new Set(present.map(normalise));
  const dirSet = new Set(directories.map(normalise));
  const failSet = new Set(failOn.map(normalise));
  const copies: [string, string][] = [];
  const dirs: string[] = [];

  return {
    copies,
    dirs,
    exists: (t) => set.has(normalise(t)) || dirSet.has(normalise(t)),
    isDirectory: (t) => dirSet.has(normalise(t)),
    mkdirp: (d) => dirs.push(d),
    copyFile: (from, to) => {
      if (failSet.has(normalise(from))) throw new Error("EACCES");
      copies.push([from, to]);
    },
    copyDirectory: (from, to) => {
      if (failSet.has(normalise(from))) throw new Error("EACCES");
      copies.push([from, to]);
    },
  };
}

describe("resolveCopyPlan", () => {
  it("maps a repo-relative path to the same path in the worktree", () => {
    const plan = resolveCopyPlan([".claude/settings.local.json"], REPO, WORKTREE);
    expect(plan.problems).toEqual([]);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].from).toBe(
      path.join(REPO, ".claude", "settings.local.json"),
    );
    expect(plan.operations[0].to).toBe(
      path.join(WORKTREE, ".claude", "settings.local.json"),
    );
  });

  it("accepts an absolute source with an explicit destination", () => {
    const plan = resolveCopyPlan(
      [{ from: "C:/shared/.env.local", to: ".env.local" }],
      REPO,
      WORKTREE,
    );
    expect(plan.problems).toEqual([]);
    expect(plan.operations[0].from).toBe(path.normalize("C:/shared/.env.local"));
    expect(plan.operations[0].to).toBe(path.join(WORKTREE, ".env.local"));
  });

  it("rejects an absolute source with no destination to infer", () => {
    const plan = resolveCopyPlan(["C:/shared/.env.local"], REPO, WORKTREE);
    expect(plan.operations).toEqual([]);
    expect(plan.problems.join(" ")).toContain("explicit relative");
  });

  it("refuses a destination that escapes the worktree", () => {
    // Otherwise a configured entry could overwrite files in the main checkout.
    for (const to of ["../escaped.json", "../../other/file", "C:/windows/system32/x"]) {
      const plan = resolveCopyPlan([{ from: "a.json", to }], REPO, WORKTREE);
      expect(plan.operations, to).toEqual([]);
      expect(plan.problems.join(" ")).toMatch(/escapes the worktree|must be relative/);
    }
  });

  it("allows a nested destination inside the worktree", () => {
    const plan = resolveCopyPlan(
      [{ from: "a.json", to: "deep/nested/a.json" }],
      REPO,
      WORKTREE,
    );
    expect(plan.operations[0].to).toBe(path.join(WORKTREE, "deep", "nested", "a.json"));
  });

  it("ignores empty and malformed entries", () => {
    const plan = resolveCopyPlan(
      ["", "   ", { from: "" }, { from: "a", to: "" }] as never,
      REPO,
      WORKTREE,
    );
    expect(plan.operations).toEqual([]);
    expect(plan.problems.length).toBeGreaterThan(0);
  });

  it("de-duplicates identical entries", () => {
    const plan = resolveCopyPlan(
      [".claude/settings.local.json", ".claude/settings.local.json"],
      REPO,
      WORKTREE,
    );
    expect(plan.operations).toHaveLength(1);
  });
});

describe("WorktreeProvisioner", () => {
  it("does nothing when nothing is configured", () => {
    const fs = fakeFs([]);
    const result = new WorktreeProvisioner(logger, fs).provision([], REPO, WORKTREE);
    expect(result).toEqual({ copied: [], missing: [], problems: [] });
    expect(fs.copies).toEqual([]);
  });

  it("copies a file and creates its parent directory", () => {
    // A fresh worktree has no .claude/ — creating it is the whole point.
    const source = path.join(REPO, ".claude", "settings.local.json");
    const fs = fakeFs([source]);
    const result = new WorktreeProvisioner(logger, fs).provision(
      [".claude/settings.local.json"],
      REPO,
      WORKTREE,
    );
    expect(result.copied).toEqual([".claude/settings.local.json"]);
    expect(fs.dirs).toContain(path.join(WORKTREE, ".claude"));
    expect(fs.copies[0][1]).toBe(path.join(WORKTREE, ".claude", "settings.local.json"));
  });

  it("copies a directory recursively", () => {
    const source = path.join(REPO, ".claude");
    const fs = fakeFs([], [source]);
    const result = new WorktreeProvisioner(logger, fs).provision(
      [".claude"],
      REPO,
      WORKTREE,
    );
    expect(result.copied).toEqual([".claude"]);
    expect(fs.copies).toEqual([[source, path.join(WORKTREE, ".claude")]]);
  });

  it("treats a missing source as benign, not a failure", () => {
    // settings.local.json is untracked and often simply absent.
    const result = new WorktreeProvisioner(logger, fakeFs([])).provision(
      [".claude/settings.local.json"],
      REPO,
      WORKTREE,
    );
    expect(result.missing).toEqual([".claude/settings.local.json"]);
    expect(result.problems).toEqual([]);
  });

  it("reports a copy failure without abandoning the remaining entries", () => {
    const bad = path.join(REPO, "locked.json");
    const good = path.join(REPO, "fine.json");
    const fs = fakeFs([bad, good], [], [bad]);
    const result = new WorktreeProvisioner(logger, fs).provision(
      ["locked.json", "fine.json"],
      REPO,
      WORKTREE,
    );
    expect(result.copied).toEqual(["fine.json"]);
    expect(result.problems.join(" ")).toContain("locked.json");
  });

  it("passes plan problems through as problems", () => {
    warnings.length = 0;
    const result = new WorktreeProvisioner(logger, fakeFs([])).provision(
      [{ from: "a.json", to: "../escape.json" }],
      REPO,
      WORKTREE,
    );
    expect(result.problems).toHaveLength(1);
    expect(warnings.join(" ")).toContain("escapes the worktree");
  });
});
