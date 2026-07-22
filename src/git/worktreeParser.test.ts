import { describe, it, expect } from "vitest";
import { parseWorktreeList } from "./worktreeParser";

describe("parseWorktreeList", () => {
  it("parses a primary worktree and a linked worktree", () => {
    const porcelain = [
      "worktree /repos/myrepo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repos/myrepo-feature",
      "HEAD def456",
      "branch refs/heads/feature/x",
      "",
    ].join("\n");

    const result = parseWorktreeList(porcelain);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ path: "/repos/myrepo", branch: "main", head: "abc123" });
    expect(result[1]).toMatchObject({ path: "/repos/myrepo-feature", branch: "feature/x" });
  });

  it("handles bare, detached, locked and prunable flags", () => {
    const porcelain = [
      "worktree /repos/bare",
      "bare",
      "",
      "worktree /repos/detached",
      "HEAD deadbeef",
      "detached",
      "",
      "worktree /repos/gone",
      "HEAD cafe",
      "branch refs/heads/gone",
      "locked",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const result = parseWorktreeList(porcelain);
    expect(result[0]).toMatchObject({ bare: true });
    expect(result[1]).toMatchObject({ detached: true });
    expect(result[1].branch).toBeUndefined();
    expect(result[2]).toMatchObject({ locked: true, prunable: true, branch: "gone" });
  });

  it("tolerates CRLF line endings and a missing trailing blank line", () => {
    const porcelain = "worktree /repos/a\r\nHEAD 111\r\nbranch refs/heads/a";
    const result = parseWorktreeList(porcelain);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: "/repos/a", branch: "a", head: "111" });
  });

  it("returns an empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
