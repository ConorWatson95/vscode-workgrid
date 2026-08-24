import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  MAX_WORKTREE_FOLDER_NAME,
  buildWorktreePath,
  validatePathSegment,
} from "./pathUtilities";

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

  // The real names that provoked this: a folder of 173 characters made a 270-char
  // NuGet targets path unopenable by devenv.exe, which is not longPathAware.
  const longSlug =
    "rename-excluded-from-campaigns-checkbox-to-exclude-from-customer-rewards-" +
    "and-narrow-its-effect-to-rewards-only-not-rebate-parts-basket-campaigns";

  const folderOf = (slug: string): string => {
    const result = buildWorktreePath({
      repositoryRoot,
      slug,
      configuredParentDir: path.resolve("/worktrees"),
    });
    expect(result.ok).toBe(true);
    return path.basename(result.ok ? result.value : "");
  };

  it("leaves a name inside the cap exactly as it was", () => {
    expect(folderOf("campaign-report")).toBe("myrepo-campaign-report");
  });

  it("caps a long name and keeps it inside the limit", () => {
    const folder = folderOf(longSlug);
    expect(folder.length).toBeLessThanOrEqual(MAX_WORKTREE_FOLDER_NAME);
    expect(folder.startsWith("myrepo-rename-excluded-from-campaigns")).toBe(true);
  });

  it("truncates at a word boundary rather than mid-word", () => {
    const folder = folderOf(longSlug);
    expect(folder).toMatch(/-[0-9a-f]{6}$/);
    // The kept head must be a whole-word prefix of the full name: the character
    // that follows it in the untruncated name is the hyphen it was cut at.
    const head = folder.slice(0, -7);
    const full = `myrepo-${longSlug}`;
    expect(full.startsWith(head)).toBe(true);
    expect(full[head.length]).toBe("-");
  });

  it("distinguishes two names sharing a long prefix", () => {
    const shared = "include-retail-r2-dealers-in-trade-parts-rebate-campaigns-";
    const first = folderOf(`${shared}but-keep-them-excluded-from-rewards`);
    const second = folderOf(`${shared}and-include-them-in-rewards-too`);
    expect(first).not.toBe(second);
  });

  it("is stable for the same slug", () => {
    expect(folderOf(longSlug)).toBe(folderOf(longSlug));
  });

  it("keeps the repository name whole when it alone fills the cap", () => {
    const wide = path.resolve(`/repos/${"r".repeat(MAX_WORKTREE_FOLDER_NAME)}`);
    const result = buildWorktreePath({
      repositoryRoot: wide,
      slug: longSlug,
      configuredParentDir: path.resolve("/worktrees"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(path.basename(result.value)).toBe(
        `${"r".repeat(MAX_WORKTREE_FOLDER_NAME)}-${path
          .basename(result.value)
          .slice(-6)}`,
      );
    }
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
