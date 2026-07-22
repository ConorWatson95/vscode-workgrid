import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { buildWorktreePath, validatePathSegment } from "./pathUtilities";

describe("buildWorktreePath", () => {
  const repositoryRoot = path.resolve("/repos/myrepo");

  it("defaults to a sibling of the repository", () => {
    const result = buildWorktreePath({
      repositoryRoot,
      slug: "campaign-report",
      configuredParentDir: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(path.resolve("/repos/myrepo-campaign-report"));
    }
  });

  it("uses the configured parent directory when provided", () => {
    const parent = path.resolve("/worktrees");
    const result = buildWorktreePath({
      repositoryRoot,
      slug: "task",
      configuredParentDir: parent,
    });
    expect(result.ok && result.value).toBe(path.resolve("/worktrees/myrepo-task"));
  });

  it("rejects an empty slug", () => {
    const result = buildWorktreePath({
      repositoryRoot,
      slug: "",
      configuredParentDir: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a relative configured parent directory", () => {
    const result = buildWorktreePath({
      repositoryRoot,
      slug: "task",
      configuredParentDir: "relative/dir",
    });
    expect(result.ok).toBe(false);
  });
});

describe("validatePathSegment", () => {
  it("accepts a normal segment", () => {
    expect(validatePathSegment("myrepo-task").ok).toBe(true);
  });

  it("rejects separators and traversal", () => {
    expect(validatePathSegment("a/b").ok).toBe(false);
    expect(validatePathSegment("..").ok).toBe(false);
  });

  it("rejects reserved Windows names", () => {
    expect(validatePathSegment("con").ok).toBe(false);
    expect(validatePathSegment("LPT1").ok).toBe(false);
  });
});
