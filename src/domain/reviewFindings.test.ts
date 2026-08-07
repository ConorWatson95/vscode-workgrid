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

  it("does not count a severity section answered with nothing", () => {
    // A clean review blocking itself: "**Important**" with "none" under it became one
    // important finding, and an important finding holds the route.
    expect(parseReviewFindings(["**Important**", "- none"].join("\n"))).toEqual([]);
    expect(parseReviewFindings(["**Critical**", "- resolved"].join("\n"))).toEqual([]);
    expect(parseReviewFindings("**Important**: none")).toEqual([]);
  });

  it("downgrades a finding whose author says they are not blocking on it", () => {
    // The reviewer's ruling on this item outranks the section they filed it under —
    // the same principle that makes a stated VERDICT outrank inferred severities.
    // Kept as a finding, because "watch the execution time on the first live run" is
    // worth reading; just not a reason to stop the route.
    const findings = parseReviewFindings(
      [
        "**Important**",
        "- no supporting index on either release table. I am not blocking on it: " +
          "the same access shape already exists. Watch the execution time on the first live run.",
      ].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("suggestion");
    expect(findings[0].text).toMatch(/Watch the execution time/);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it("leaves a finding that says it IS blocking", () => {
    const findings = parseReviewFindings(
      ["**Important**", "- this is blocking until the index exists"].join("\n"),
    );
    expect(findings[0].severity).toBe("important");
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

describe("a heading that carries its finding", () => {
  // Verbatim shape from a real SQL object review that reported a blocking problem
  // and displayed as clean: the severity heading also states the problem, which put
  // it over the 40-character label cap, and the generic heading rule then cleared
  // the severity so nothing at all was recorded.
  const REPLY = [
    "What I found already in place",
    "",
    "The only code change is one line adding SalesMonth to the SELECT list.",
    "",
    "### Critical: the change is against the wrong stored procedure",
    "",
    "RU-547 has an attachment the earlier stages did not read.",
    "",
    "### Important: column position is not controlled by the SELECT list",
    "",
    "FieldName is matched by name; order comes from Weight.",
    "",
    "The rest of the checklist",
    "",
    "- Layer: correct in principle.",
    "- Encoding: UTF-16LE with BOM intact.",
    "",
    "VERDICT: block",
  ].join("\n");

  it("reads the finding out of the heading that states it", () => {
    const findings = parseReviewFindings(REPLY);
    expect(findings).toEqual([
      { severity: "critical", text: "the change is against the wrong stored procedure" },
      { severity: "important", text: "column position is not controlled by the SELECT list" },
    ]);
  });

  it("blocks on it, and says so", () => {
    const findings = parseReviewFindings(REPLY);
    expect(hasBlockingFindings(findings)).toBe(true);
    expect(summariseFindings(findings)).toBe("1 critical, 1 important");
  });

  it("does not let the checklist below inherit the last severity", () => {
    // "The rest of the checklist" clears it. Those bullets are the review saying
    // things are fine, and counting them was how one blocker became fourteen.
    expect(parseReviewFindings(REPLY)).toHaveLength(2);
  });

  it("keeps a bare severity line from claiming the bullets after it", () => {
    // Not a marked heading, so it reports itself and nothing else. A plain bullet
    // following it has no severity of its own and is not a finding.
    const findings = parseReviewFindings(
      ["CRITICAL: the migration drops a column", "- unrelated observation"].join("\n"),
    );
    expect(findings).toEqual([
      { severity: "critical", text: "the migration drops a column" },
    ]);
  });

  it("still treats a severity word in a heading as a section, not a finding", () => {
    // "### Critical path analysis" names a section; there is no problem stated.
    const findings = parseReviewFindings(
      ["### Critical path analysis", "- the overnight proc is the long pole"].join("\n"),
    );
    expect(findings).toEqual([
      { severity: "critical", text: "the overnight proc is the long pole" },
    ]);
  });
});
