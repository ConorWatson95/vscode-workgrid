import { describe, expect, it } from "vitest";
import { parsePlanQuestions, planQuestionsReason } from "./planQuestions";

describe("parsePlanQuestions", () => {
  it("finds items listed under an open-questions heading", () => {
    const questions = parsePlanQuestions(
      [
        "# Plan",
        "1. Build the proc.",
        "",
        "## Open questions / risks",
        "1. Does the footnote apply to box 10 or the whole Trade side?",
        "2. Is Rolling 12 in scope for this ticket?",
      ].join("\n"),
    );
    expect(questions.map((q) => q.line)).toEqual([5, 6]);
    expect(questions[0].text).toBe("Does the footnote apply to box 10 or the whole Trade side?");
  });

  it("stops at the next heading, so following sections are not questions", () => {
    const questions = parsePlanQuestions(
      ["## Open questions", "- Which colour scheme?", "", "## Next steps", "- Build it."].join("\n"),
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe("Which colour scheme?");
  });

  it("finds a question raised inline inside a numbered step", () => {
    // The pyramid plan's actual shape: three of its questions were mid-step.
    const questions = parsePlanQuestions(
      [
        "3. Add the IMT Pen box. Flag as an open question (does it apply to just",
        "   box 10, or the whole Trade side?)",
      ].join("\n"),
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].line).toBe(1);
  });

  it("does not hold a plan whose open-questions section says none", () => {
    for (const body of ["- none", "- None.", "- No open questions", "- All resolved"]) {
      expect(parsePlanQuestions(`## Open questions\n${body}`)).toEqual([]);
    }
  });

  it("does not hold a plan with no questions section at all", () => {
    expect(
      parsePlanQuestions(
        ["# Plan", "1. Build the proc.", "2. Wire the controller.", "## Next steps", "- Ship."].join(
          "\n",
        ),
      ),
    ).toEqual([]);
  });

  it("ignores a rhetorical question used as structure", () => {
    // A question mark alone must never hold: well-written plans use them as headings
    // and answer them in the same breath.
    expect(
      parsePlanQuestions("Which report does this match? The Aftersales dashboard — see below."),
    ).toEqual([]);
  });

  it("ignores 'unclear' and 'TBC' describing existing code", () => {
    expect(
      parsePlanQuestions("2. The existing proc's grouping is unclear; document it as found. TBC."),
    ).toEqual([]);
  });

  it("counts an inline phrase inside a listed question once", () => {
    const questions = parsePlanQuestions(
      ["## Open questions", "- Colour scheme: question for sign off."].join("\n"),
    );
    expect(questions).toHaveLength(1);
  });

  it("caps what it reports", () => {
    const body = Array.from({ length: 30 }, (_, i) => `- Question ${i + 1}?`).join("\n");
    expect(parsePlanQuestions(`## Open questions\n${body}`)).toHaveLength(12);
  });

  it("matches the heading spellings plans actually use", () => {
    for (const heading of [
      "## Open questions",
      "## Open Questions / Risks",
      "### Risks and open questions",
      "## Unresolved",
      "## To confirm",
      "## Needs a human decision",
      "## Assumptions to confirm",
      "#### Open items",
      "## Awaiting decision",
    ]) {
      expect(parsePlanQuestions(`${heading}\n- Which one?`), heading).toHaveLength(1);
    }
  });
});

/**
 * The shape that actually cost eighteen corrections, verbatim from
 * NMGB-2814's `docs/plans/<branch>/rc-plan.md` lines 355-362.
 *
 * A fixture rather than a read of the working copy: a test pointing at one
 * machine's worktree passes there and silently skips everywhere else, which is
 * the same "looks configured, never fires" failure this module exists to catch.
 * Checked against the real 429-line document when this was written — it found 12,
 * the cap.
 */
describe("the plan that caused this", () => {
  const REAL = [
    "## Open questions / risks",
    "",
    '1. "Only shows current quarter performance regardless of period selected"',
    "   footnote in Summary Calculations, unclear scope (one KPI vs whole Trade",
    "   side vs whole report). Needs sign off before SQL is written, since it",
    `   contradicts the ticket's "all pyramid measures ... must recompute for the`,
    '   selected period" rule if applied broadly.',
    "2. Box 8's Current/Previous/Variance/Nat rows are not spelled out in Detail",
  ].join(String.fromCharCode(10));

  it("holds on it, and reports the numbered items rather than every wrapped line", () => {
    const found = parsePlanQuestions(REAL);
    expect(found.map((q) => q.line)).toEqual([3, 8]);
    expect(found[0].text).toContain("Only shows current quarter performance");
  });
});

describe("planQuestionsReason", () => {
  it("names the file and where to look", () => {
    const reason = planQuestionsReason("docs/plans/x/rc-plan.md", [
      { text: "a", line: 355 },
      { text: "b", line: 358 },
    ]);
    expect(reason).toContain("docs/plans/x/rc-plan.md");
    expect(reason).toContain("2 unresolved question(s)");
    expect(reason).toContain("line 355, line 358");
  });
});
