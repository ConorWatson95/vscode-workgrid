import { describe, it, expect } from "vitest";
import { slugify, buildBranchName, validateBranchName } from "./branchName";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Campaign Performance Report")).toBe(
      "campaign-performance-report",
    );
  });

  it("collapses runs of non-alphanumerics", () => {
    expect(slugify("Fix   the___bug!!!")).toBe("fix-the-bug");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });

  it("strips diacritics", () => {
    expect(slugify("Café Ölçü")).toBe("cafe-olcu");
  });

  it("returns empty for symbol-only input", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("buildBranchName", () => {
  it("combines prefix and slug", () => {
    const result = buildBranchName("feature", "Campaign Report");
    expect(result.ok && result.value).toBe("feature/campaign-report");
  });

  it("omits prefix when empty", () => {
    const result = buildBranchName("", "Hotfix");
    expect(result.ok && result.value).toBe("hotfix");
  });

  it("fails when the task name has no usable characters", () => {
    const result = buildBranchName("bug", "###");
    expect(result.ok).toBe(false);
  });
});

describe("validateBranchName", () => {
  it("accepts a normal branch", () => {
    expect(validateBranchName("feature/x").ok).toBe(true);
  });

  it.each(["/leading", "trailing/", "has..dots", "a//b", "end.lock", "with space"])(
    "rejects %s",
    (branch) => {
      expect(validateBranchName(branch).ok).toBe(false);
    },
  );
});
