import { describe, expect, it } from "vitest";
import { fileLink } from "./reportLinks";

const WORKTREE = "C:/Dev/worktress/qubeautoapp-ru-563";

describe("fileLink", () => {
  it("resolves a relative path against the worktree, never the main checkout", () => {
    expect(fileLink("QubeAutoApp/Areas/Marketing/Views/MarketingActivity.cshtml", WORKTREE)).toBe(
      "[`QubeAutoApp/Areas/Marketing/Views/MarketingActivity.cshtml`]" +
        "(file:///C:/Dev/worktress/qubeautoapp-ru-563/QubeAutoApp/Areas/Marketing/Views/MarketingActivity.cshtml)",
    );
  });

  it("keeps an absolute path as recorded", () => {
    expect(fileLink("C:\\Dev\\x\\a.cs", WORKTREE)).toBe(
      "[`C:\\Dev\\x\\a.cs`](file:///C:/Dev/x/a.cs)",
    );
  });

  it("shows the path as recorded, not the resolved one", () => {
    expect(fileLink("src/a.ts", WORKTREE)).toContain("[`src/a.ts`]");
  });

  it("falls back to plain code when there is no worktree to resolve against", () => {
    expect(fileLink("src/a.ts", undefined)).toBe("`src/a.ts`");
  });

  it("strips a leading ./ and a trailing worktree separator", () => {
    expect(fileLink("./a.ts", "C:/Dev/wt/")).toBe("[`./a.ts`](file:///C:/Dev/wt/a.ts)");
  });

  it("encodes a space without destroying the drive letter", () => {
    expect(fileLink("a b.ts", "C:/Users/Conor Watson/wt")).toBe(
      "[`a b.ts`](file:///C:/Users/Conor%20Watson/wt/a%20b.ts)",
    );
  });

  it("handles a POSIX root", () => {
    expect(fileLink("/home/x/a.ts", undefined)).toBe("[`/home/x/a.ts`](file:///home/x/a.ts)");
  });

  it("links a backslash-relative path into the worktree", () => {
    expect(fileLink("QubeAutoApp\\Views\\A.cshtml", WORKTREE)).toBe(
      "[`QubeAutoApp\\Views\\A.cshtml`]" +
        "(file:///C:/Dev/worktress/qubeautoapp-ru-563/QubeAutoApp/Views/A.cshtml)",
    );
  });
});
