import { describe, expect, it } from "vitest";
import { fileLink, linkifyPaths } from "./reportLinks";

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

describe("linkifyPaths", () => {
  const worktree = "C:/Dev/worktrees/task";

  it("links a path the reply names in prose", () => {
    const out = linkifyPaths("Plan written to `docs/plans/fix/rc-plan.md`.", worktree);
    expect(out).toContain("[`docs/plans/fix/rc-plan.md`](file:///C:/Dev/worktrees/task/docs/plans/fix/rc-plan.md)");
  });

  it("leaves backticked things that are not paths alone", () => {
    // Every one of these is from a real report that also contained a real path.
    for (const token of ["#ddlPeriodFrom", "export-param", "d-none", "dealerreviewsummary.js"]) {
      expect(linkifyPaths(`the \`${token}\` class`, worktree)).toBe(`the \`${token}\` class`);
    }
  });

  it("links a nested view path", () => {
    const out = linkifyPaths("mirrors `Areas/Aftersales/Views/Bespoke/KPI/GB/Scorecard.cshtml` which", worktree);
    expect(out).toContain("](file:///C:/Dev/worktrees/task/Areas/Aftersales/Views/Bespoke/KPI/GB/Scorecard.cshtml)");
  });

  it("leaves fenced blocks alone, because markdown renders no link inside one", () => {
    const fenced = "before\n\n```\ncat docs/plans/x.md\n`docs/plans/x.md`\n```\n\nafter";
    expect(linkifyPaths(fenced, worktree)).toBe(fenced);
  });

  it("does not double-wrap a path that is already a link", () => {
    const already = "see [`docs/x.md`](file:///C:/Dev/worktrees/task/docs/x.md) for detail";
    expect(linkifyPaths(already, worktree)).toBe(already);
  });

  it("leaves a URL alone", () => {
    const url = "opened `https://bitbucket.org/q/pull-requests/1.md` today";
    expect(linkifyPaths(url, worktree)).toBe(url);
  });

  it("absence of a worktree means unchanged", () => {
    const text = "Plan written to `docs/plans/fix/rc-plan.md`.";
    expect(linkifyPaths(text, undefined)).toBe(text);
  });
});
