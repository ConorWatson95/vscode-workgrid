import { describe, expect, it } from "vitest";
import { amendmentIsUnreachable, correctionReaches } from "./amendmentReach";

const SQL_REVIEW = {
  addedByRule: "SQL objects changed",
  rulePaths: { pathPattern: "\\.sql$" },
  status: "pending" as const,
};

/** What the `@using DevExpress.Web.Mvc.UI` correction actually wrote. */
const RAZOR_FIX = [
  "C:\\Dev\\worktrees\\qubeautoapp-dealer-review-summary-pyramid\\QubeAutoApp\\Areas" +
    "\\TotalBusiness\\Views\\Bespoke\\DealerReviewSummary\\GB\\Index.cshtml",
];

describe("correctionReaches", () => {
  it("does not reach a SQL review from a Razor one-liner", () => {
    expect(correctionReaches(SQL_REVIEW, RAZOR_FIX)).toBe(false);
  });

  it("matches a backslashed absolute path against a rule's own spelling", () => {
    // `pathsWritten` is recorded as the tool reported it, which on Windows is
    // absolute and backslashed; a rule pattern is written against a repo-relative
    // forward-slash path. A miss for that reason would switch a review off.
    expect(
      correctionReaches(
        { addedByRule: "migrations", rulePaths: { pathPattern: "tools/sql/.*/deploy/" } },
        ["C:\\Dev\\worktrees\\app\\Tools\\SQL\\NissanGB\\Deploy\\004_pyramid.sql"],
      ),
    ).toBe(true);
  });

  it("honours the rule's exception", () => {
    expect(
      correctionReaches(
        {
          addedByRule: "mapping",
          rulePaths: { pathPattern: "Mapping/", exceptPattern: "\\.test\\." },
        },
        ["src/Mapping/thing.test.cs"],
      ),
    ).toBe(false);
  });

  it("is unmeasured for a route stage, an old pipeline, and a correction that wrote nothing", () => {
    expect(correctionReaches({ rulePaths: SQL_REVIEW.rulePaths }, RAZOR_FIX)).toBeUndefined();
    expect(correctionReaches({ addedByRule: "SQL" }, RAZOR_FIX)).toBeUndefined();
    expect(correctionReaches(SQL_REVIEW, [])).toBeUndefined();
    expect(correctionReaches(SQL_REVIEW, undefined)).toBeUndefined();
  });

  it("is unmeasured when the pattern will not compile", () => {
    // Two readers of one string disagreeing must not settle a review. Answering
    // "no" here is the one outcome worth more than the saving.
    expect(
      correctionReaches({ addedByRule: "broken", rulePaths: { pathPattern: "([" } }, RAZOR_FIX),
    ).toBeUndefined();
  });
});

describe("amendmentIsUnreachable", () => {
  it("withdraws only from a pending stage", () => {
    expect(amendmentIsUnreachable(SQL_REVIEW, RAZOR_FIX)).toBe(true);
    for (const status of ["active", "failed", "blocked", "passed"] as const) {
      expect(amendmentIsUnreachable({ ...SQL_REVIEW, status }, RAZOR_FIX)).toBe(false);
    }
  });

  it("keeps the amendment whenever the question cannot be answered", () => {
    expect(amendmentIsUnreachable({ status: "pending" }, RAZOR_FIX)).toBe(false);
    expect(amendmentIsUnreachable(SQL_REVIEW, undefined)).toBe(false);
  });
});
