import { describe, expect, it } from "vitest";
import {
  formatFindings,
  hasBlockingFindings,
  parseReviewFindings,
  summariseFindings,
} from "./reviewFindings";

describe("parseReviewFindings", () => {
  it("reads items under severity headings", () => {
    const findings = parseReviewFindings(
      [
        "I reviewed the changed objects.",
        "",
        "## Critical",
        "- The migration drops OrderRef before backfilling it.",
        "",
        "## Important",
        "- No rollback script.",
        "- The index is not filtered, so it covers soft-deleted rows.",
        "",
        "## Suggestions",
        "- Name the constraint explicitly.",
      ].join("\n"),
    );

    expect(findings).toEqual([
      {
        severity: "critical",
        text: "The migration drops OrderRef before backfilling it.",
      },
      { severity: "important", text: "No rollback script." },
      {
        severity: "important",
        text: "The index is not filtered, so it covers soft-deleted rows.",
      },
      { severity: "suggestion", text: "Name the constraint explicitly." },
    ]);
  });

  it("reads inline markers with no heading at all", () => {
    const findings = parseReviewFindings(
      ["CRITICAL: the proc is created without SET NOCOUNT ON.", "nit: trailing whitespace."].join(
        "\n",
      ),
    );
    expect(findings).toEqual([
      { severity: "critical", text: "the proc is created without SET NOCOUNT ON." },
      { severity: "suggestion", text: "trailing whitespace." },
    ]);
  });

  it("accepts the words an agent reaches for instead", () => {
    const findings = parseReviewFindings(
      ["- blocker: no idempotency guard", "- Consider: extract the join"].join("\n"),
    );
    expect(findings.map((f) => f.severity)).toEqual(["critical", "suggestion"]);
  });

  it("lets an inline marker override the heading above it", () => {
    // The writer correcting themselves mid-list. Taking the heading would report a
    // nitpick as a blocker.
    const findings = parseReviewFindings(
      ["## Critical", "- (minor) the alias is inconsistent"].join("\n"),
    );
    expect(findings).toEqual([
      { severity: "suggestion", text: "the alias is inconsistent" },
    ]);
  });

  it("ignores prose that merely mentions a severity", () => {
    // Otherwise every bulleted line after this sentence becomes critical.
    const findings = parseReviewFindings(
      [
        "Nothing here is critical, but the shape of the change is worth discussing at length.",
        "- the join could be a CTE",
      ].join("\n"),
    );
    expect(findings).toEqual([]);
  });

  it("returns nothing for a reply with no findings, rather than guessing", () => {
    expect(parseReviewFindings("Reviewed. Everything looks consistent.")).toEqual([]);
    expect(parseReviewFindings(undefined)).toEqual([]);
    expect(parseReviewFindings("   ")).toEqual([]);
  });

  it("reads numbered lists", () => {
    const findings = parseReviewFindings(["Important", "1. no rollback", "2) no test"].join("\n"));
    expect(findings.map((f) => f.text)).toEqual(["no rollback", "no test"]);
  });
});

describe("summariseFindings", () => {
  it("counts by severity, worst first", () => {
    const findings = parseReviewFindings(
      [
        "## Suggestions",
        "- a",
        "- b",
        "## Critical",
        "- c",
        "## Important",
        "- d",
        "- e",
      ].join("\n"),
    );
    expect(summariseFindings(findings)).toBe("1 critical, 2 important, 2 suggestions");
  });

  it("uses the singular for one suggestion", () => {
    expect(summariseFindings([{ severity: "suggestion", text: "a" }])).toBe("1 suggestion");
  });

  it("says nothing when there is nothing", () => {
    expect(summariseFindings([])).toBeUndefined();
  });
});

describe("hasBlockingFindings", () => {
  it("treats critical and important as blocking", () => {
    expect(hasBlockingFindings([{ severity: "important", text: "a" }])).toBe(true);
    expect(hasBlockingFindings([{ severity: "critical", text: "a" }])).toBe(true);
  });

  it("does not treat suggestions as blocking", () => {
    expect(hasBlockingFindings([{ severity: "suggestion", text: "a" }])).toBe(false);
    expect(hasBlockingFindings([])).toBe(false);
  });
});

describe("formatFindings", () => {
  it("groups by severity, worst first", () => {
    const findings = parseReviewFindings(
      ["## Suggestions", "- tidy the alias", "## Critical", "- drops a column"].join("\n"),
    );
    expect(formatFindings(findings)).toBe(
      ["**Critical**", "- drops a column", "", "**Suggestions**", "- tidy the alias"].join("\n"),
    );
  });
});

describe("sections that clear the severity", () => {
  // Shaped like a real SQL object review: one blocker, then a long section whose
  // whole purpose is to say the rest is fine.
  const REPORT = [
    "SQL object review complete. No SQL was changed in this stage.",
    "",
    "Must fix before UAT promotion",
    "- Migration 004 hard-codes Bespoke_KPI.Id = 49; UAT has no Id 49.",
    "",
    "Other review points",
    "- Sargability is fine: equality predicates on PeriodId.",
    "- Join cardinality is pre-existing and shared by all six sibling procs.",
    "- NULL handling is sound.",
    "- Minor ordering nit: apply 002 before 001.",
    "",
    "Manufacturers affected",
    "- NissanGB only, 1 of the 6.",
  ].join("\n");

  it("counts the blocker once, not the whole document", () => {
    // The reported bug: one "Must fix" heading made fourteen findings critical,
    // because a non-severity heading did not clear the context.
    const findings = parseReviewFindings(REPORT);
    const critical = findings.filter((f) => f.severity === "critical");
    expect(critical).toHaveLength(1);
    expect(critical[0].text).toContain("Bespoke_KPI.Id = 49");
  });

  it("does not classify the cleared sections at all", () => {
    const findings = parseReviewFindings(REPORT);
    expect(findings.map((f) => f.text)).not.toContain("NULL handling is sound.");
  });

  it("still reads an explicit marker inside a cleared section", () => {
    // "Minor ordering nit:" carries its own severity, so it survives the clear.
    const findings = parseReviewFindings(REPORT);
    expect(findings.some((f) => f.severity === "suggestion")).toBe(true);
  });

  it("clears on a markdown heading too", () => {
    const findings = parseReviewFindings(
      ["## Critical", "- real one", "## Notes", "- not a finding"].join("\n"),
    );
    expect(findings).toHaveLength(1);
  });

  it("does not treat a short sentence as a heading", () => {
    // That would clear the severity mid-list and lose the rest of the section.
    const findings = parseReviewFindings(
      ["## Critical", "- one", "It also drops a column.", "- two"].join("\n"),
    );
    expect(findings.filter((f) => f.severity === "critical")).toHaveLength(2);
  });
});
