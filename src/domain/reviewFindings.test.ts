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

/**
 * A severity section written without bullets.
 *
 * The failure that prompted it: a SQL review headed a section "Critical" and listed
 * three procedures on plain lines. `listItem` accepts only a bulleted line or one
 * carrying its own severity marker, so all three were skipped and the review parsed to
 * nothing — while the report, which shows the reply verbatim when nothing parses,
 * displayed them. Three criticals on screen, an empty list in the decision, and a route
 * that carried on to the next stage.
 */
describe("a fenced code block", () => {
  // The real review that found this: two problems written as prose, the first with
  // the three offending lines quoted underneath. It parsed to seven criticals — the
  // three statements, both fence markers, and the two actual findings — and the
  // fences rendered as empty code boxes in the report.
  const WITH_SNIPPET = [
    "### Critical",
    "",
    "**`CreateCSV` discards the override it was just given.** `BaseController.cs:257-260`:",
    "",
    "```csharp",
    "var exportOptions = exportOptionsOverride ?? DefaultCsvExportOptions;",
    "exportOptions.WritePreamble = false;",
    "exportOptions.ExportType = DevExpress.Export.ExportType.Default;",
    "```",
    "",
    "The two lines after the resolve stomp ExportType back to Default",
  ].join("\n");

  it("is evidence for the finding above it, not findings of its own", () => {
    const findings = parseReviewFindings(WITH_SNIPPET);
    expect(findings).toHaveLength(2);
    expect(summariseFindings(findings)).toBe("2 critical");
  });

  it("leaves no fence marker to render as an empty code block", () => {
    expect(formatFindings(parseReviewFindings(WITH_SNIPPET))).not.toContain("```");
  });

  it("does not let a severity word inside code start a section", () => {
    const findings = parseReviewFindings(
      ["```", "// Critical", "throw new Exception();", "```"].join("\n"),
    );
    expect(findings).toEqual([]);
  });

  it("reads a bulleted section after the block as usual", () => {
    const findings = parseReviewFindings(
      ["```sql", "SELECT 1", "```", "", "## Important", "", "- the join double-counts"].join("\n"),
    );
    expect(findings).toEqual([{ severity: "important", text: "the join double-counts" }]);
  });
});

describe("a section that uses no bullets", () => {
  const UNBULLETED = [
    "Critical",
    "",
    "p_Bespoke_TradeCampaign_DescriptionCode lines 171 and 194",
    "_ByCustomer line 164",
  ].join("\n");

  it("reads the plain lines as findings rather than nothing", () => {
    const findings = parseReviewFindings(UNBULLETED);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "critical")).toBe(true);
    expect(findings[0].text).toContain("lines 171 and 194");
  });

  it("holds the route, which is the whole point", () => {
    expect(hasBlockingFindings(parseReviewFindings(UNBULLETED))).toBe(true);
  });

  it("does not apply where the section already has bulleted items", () => {
    // A reviewer who bulleted anything is writing prose in between, and reading each
    // line of a wrapped paragraph as its own critical is the over-count that teaches
    // people to click past the stop.
    const mixed = [
      "## Critical",
      "",
      "These both stem from the same missing predicate, verified against the procs:",
      "",
      "- p_DescriptionCode line 171",
      "- _ByCustomer line 164",
    ].join("\n");
    const findings = parseReviewFindings(mixed);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.text)).not.toContain(
      "These both stem from the same missing predicate, verified against the procs:",
    );
  });

  it("does not apply where the heading carried its own finding", () => {
    // The lines under it are that finding's explanation, not more findings.
    const carried = [
      "### Critical: the change is against the wrong stored procedure",
      "",
      "The ticket names p_Rewards, and the edit landed in p_RewardsSummary.",
    ].join("\n");
    expect(parseReviewFindings(carried)).toHaveLength(1);
  });

  it("still ignores a section answered with nothing", () => {
    // "Critical" followed by a plain "none" is a section answered, and counting it
    // would block a clean review on the absence of work.
    expect(parseReviewFindings(["**Critical**", "", "none"].join("\n"))).toEqual([]);
  });

  it("gives plain lines outside any severity section no severity at all", () => {
    // There is nothing to classify them as, and guessing is how a report becomes
    // fourteen blockers.
    expect(parseReviewFindings(["## Summary", "", "I read the two procs."].join("\n"))).toEqual([]);
  });

  it("still downgrades a plain line whose author says they are not blocking", () => {
    const findings = parseReviewFindings(
      ["Important", "", "index is missing, though I am not blocking on it"].join("\n"),
    );
    expect(findings[0].severity).toBe("suggestion");
  });

  it("ends the fallback at the next heading, not at the end of the reply", () => {
    const two = [
      "## Critical",
      "",
      "p_DescriptionCode line 171",
      "",
      "## Other review points",
      "",
      "The naming is consistent with the rest of the folder.",
    ].join("\n");
    const findings = parseReviewFindings(two);
    expect(findings).toHaveLength(1);
    expect(findings[0].text).toContain("line 171");
  });
});

/**
 * The eighth false stop of this family, and the first through the severity *label*
 * rather than the finding text.
 */
describe("a label that counts no findings", () => {
  it("does not turn a closing 'nothing outstanding' line into a critical", () => {
    // Verbatim from a planning stage that had done its work and said so. Read as the
    // label "No blocking or deferred items" — 29 characters, all letters, containing
    // "blocking" — with the sentence after the dash as the critical it introduced.
    const findings = parseReviewFindings(
      "No blocking or deferred items — all findings from the prior review rounds were " +
        "already addressed by earlier stages, and I resolved the two remaining " +
        "ambiguities directly with the operator instead of leaving them open.",
    );
    expect(findings).toEqual([]);
  });

  it("keeps a real finding whose subject merely starts with a negative", () => {
    // The reason this is keyed on the head noun rather than on the negator. Dropping
    // a real finding is the worse error, in this rule as in every other one here.
    const findings = parseReviewFindings(
      "- No error handling — the retry loop swallows every exception",
    );
    expect(findings).toEqual([
      { severity: "critical", text: "the retry loop swallows every exception" },
    ]);
  });

  it("answers a heading spelt as a count of none", () => {
    expect(parseReviewFindings("## No blocking issues: the migration pairs up")).toEqual(
      [],
    );
  });

  it("still reads an ordinary marker", () => {
    expect(parseReviewFindings("- Blocking: the proc drops a column")).toEqual([
      { severity: "critical", text: "the proc drops a column" },
    ]);
  });
});

/**
 * The ninth false stop, and the second in a day through the severity label rather
 * than the finding text.
 */
describe("a label that is the opening of a sentence", () => {
  it("does not turn a paragraph about findings into a finding", () => {
    // Verbatim from a deployment preview reporting that both items were already
    // fixed. The 39 characters before the first dash are letters and spaces, inside
    // the length cap, and contain "critical".
    const findings = parseReviewFindings(
      "The two critical items the finding names — By Part Number's stale `deploy/003` " +
        "and By Description Code's missing `deploy/` folder — were both already resolved " +
        "by the time this stage ran.",
    );
    expect(findings).toEqual([]);
  });

  it("still reads a multi-word marker that names a severity", () => {
    // Why this is a leading-word test and not a tighter length cap: the label
    // above was already inside the cap, so tightening it far enough to exclude a
    // seven-word sentence would take real markers like this one with it.
    expect(parseReviewFindings("- Blocking issue — the proc drops a column")).toEqual(
      [{ severity: "critical", text: "the proc drops a column" }],
    );
  });

  it("leaves a bare heading alone, so its section keeps its severity", () => {
    // The guard is not applied to a heading with no summary of its own. Refusing
    // one would clear the severity for every item under it — a real blocking
    // finding parsing to nothing, which is the direction this file refuses to
    // fail in.
    expect(
      parseReviewFindings("## Critical issues\n\n- the migration drops a column"),
    ).toEqual([{ severity: "critical", text: "the migration drops a column" }]);
  });
});

describe("a label carrying the delimiter it was split on", () => {
  it("reports no findings when the count of none was delimited with --", () => {
    // The eighth false stop, spelt the way an agent writes an em-dash when its
    // output is ASCII. `negatedCount` is anchored on the label's last word, and the
    // label pattern allows a hyphen inside a label — so the label kept the first of
    // the two, ended in a hyphen rather than "items", and the guard added for this
    // exact sentence never fired. No rule was broken and nothing was on screen to
    // say so.
    expect(
      parseReviewFindings(
        "No blocking or deferred items -- all findings from the prior review " +
          "rounds were already addressed by earlier stages.",
      ),
    ).toEqual([]);
  });

  it("reads the same label the same way whichever dash delimits it", () => {
    // The point of normalising once rather than per guard: every spelling of the
    // same sentence has to reach the same answer, or the fix is a fix for one
    // rendering of one reply.
    for (const dash of ["—", "–", "-", "--", ":"]) {
      expect(
        parseReviewFindings(`No blocking or deferred items ${dash} all already addressed.`),
      ).toEqual([]);
    }
  });
});

describe("a marker whose severity word is two words", () => {
  it("reads a multi-word severity inside a longer label", () => {
    // A label is searched a word at a time, so "must fix" — two words — was never
    // found in one: "Must-fix:" was critical while this was *nothing at all*. The
    // dropped-finding direction, on the exact label `startsLikeSentence`'s own
    // reasoning names as one worth keeping.
    expect(
      parseReviewFindings("Must fix before UAT promotion — the proc reads the wrong table"),
    ).toEqual([{ severity: "critical", text: "the proc reads the wrong table" }]);
  });

  it("matches a phrase on word boundaries, not by substring", () => {
    // "fix" inside "fixture" is not a severity, or the loosening trades a dropped
    // finding for the over-count that teaches people to click past the stop.
    expect(parseReviewFindings("Fixture setup notes — the harness seeds two rows")).toEqual(
      [],
    );
  });
});
