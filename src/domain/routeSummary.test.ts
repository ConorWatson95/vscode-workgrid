import { describe, expect, it } from "vitest";

import { MAX_SUMMARY_CHARS, summariseIntent } from "./routeSummary";

describe("summariseIntent", () => {
  it("returns a short intent unchanged", () => {
    const intent =
      "Independent senior review of the finished diff. Check backwards compatibility.";
    expect(summariseIntent(intent)).toBe(intent);
  });

  it("keeps the objective and drops the method", () => {
    const intent =
      "Implement ONLY the database side of the approved plan: the stored procedure that " +
      "feeds the report. Write no C#, no view, no controller. " +
      "Follow the conventions in tools/sql/README.md and run the linter before finishing. " +
      "Name the migration after the ticket.";

    const summary = summariseIntent(intent);

    expect(summary).toContain("Implement ONLY the database side");
    expect(summary).not.toContain("linter");
  });

  it("pulls in a second sentence when the first is too thin to identify the stage", () => {
    const intent =
      "Investigate before writing code. List the ticket's attachments and read any " +
      "template or spec. " +
      "Then write the plan out in full, covering every table the report touches, and " +
      "say which ones are new. Name each migration after the ticket, pair it with a " +
      "rollback, and state the target database explicitly at the top of every file.";

    expect(summariseIntent(intent)).toBe(
      "Investigate before writing code. List the ticket's attachments and read any template or spec.",
    );
  });

  it("never exceeds the cap", () => {
    const intent = `${"word ".repeat(200)}. And another sentence.`;
    expect(summariseIntent(intent).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 1);
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const summary = summariseIntent(`${"alpha bravo ".repeat(40)}charlie.`);

    expect(summary.endsWith("…")).toBe(true);
    // The cut lands after a whole word, never part-way through one.
    expect(summary.slice(0, -1)).toMatch(/(alpha|bravo)$/);
  });

  it("flattens newlines, so a multi-line intent stays one line", () => {
    expect(summariseIntent("Deploy to DEV.\n  Run the migration\n  then the rollback.")).toBe(
      "Deploy to DEV. Run the migration then the rollback.",
    );
  });

  it("is stable — the same intent always yields the same text", () => {
    const intent = `${"detail ".repeat(60)}. Second sentence here.`;
    expect(summariseIntent(intent)).toBe(summariseIntent(intent));
  });
});
