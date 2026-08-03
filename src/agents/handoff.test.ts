import { describe, it, expect } from "vitest";
import {
  HANDOFF_PROMPT,
  Handoff,
  formatHandoffBrief,
  isEmptyHandoff,
  parseHandoff,
} from "./handoff";

const REPLY = `## Summary
Halfway through replacing the mapping profile. Build passes.

## Done
- Rewrote CustomerProfile to map DealerId explicitly
- Added a unit test for the null branch

## Remaining
- Report exports still untested
- 2. Dealer lookup needs checking

## Decisions
- Rejected mapping via a converter: it hid the null case
- Constraint: cannot change the DTO, other teams consume it

## Files
src/Mapping/CustomerProfile.cs
tests/Mapping/CustomerProfileTests.cs

## Next step
Verify report exports against staging.`;

describe("parseHandoff", () => {
  it("extracts every section", () => {
    const { handoff, structured } = parseHandoff(REPLY);
    expect(structured).toBe(true);
    expect(handoff.summary).toContain("Halfway through");
    expect(handoff.done).toHaveLength(2);
    expect(handoff.remaining).toEqual([
      "Report exports still untested",
      "Dealer lookup needs checking",
    ]);
    expect(handoff.decisions[1]).toContain("cannot change the DTO");
    expect(handoff.filesTouched).toEqual([
      "src/Mapping/CustomerProfile.cs",
      "tests/Mapping/CustomerProfileTests.cs",
    ]);
    expect(handoff.nextStep).toBe("Verify report exports against staging.");
  });

  it("strips bullets, numbers and unicode dots alike", () => {
    const { handoff } = parseHandoff("## Done\n- a\n* b\n+ c\n1. d\n2) e\n• f");
    expect(handoff.done).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("joins multi-line prose sections", () => {
    const { handoff } = parseHandoff("## Summary\nOne line.\nAnother line.");
    expect(handoff.summary).toBe("One line. Another line.");
  });

  it("accepts alternative headings", () => {
    const { handoff } = parseHandoff(
      "### Completed\n- x\n### Outstanding\n- y\n### Constraints\n- z\n### Paths\n- p",
    );
    expect(handoff.done).toEqual(["x"]);
    expect(handoff.remaining).toEqual(["y"]);
    expect(handoff.decisions).toEqual(["z"]);
    expect(handoff.filesTouched).toEqual(["p"]);
  });

  it("keeps an unstructured reply whole rather than discarding it", () => {
    // Losing the only record of a session because the model ignored the format
    // would be far worse than an unshaped summary.
    const { handoff, structured } = parseHandoff("I did some work on the mapper.");
    expect(structured).toBe(false);
    expect(handoff.summary).toBe("I did some work on the mapper.");
  });

  it("ignores text before the first heading", () => {
    const { handoff } = parseHandoff("Sure, here you go!\n\n## Summary\nReal content.");
    expect(handoff.summary).toBe("Real content.");
  });

  it("never throws on empty or whitespace input", () => {
    expect(parseHandoff("").handoff.summary).toBe("");
    expect(parseHandoff("   \n  ").handoff.summary).toBe("");
  });
});

describe("formatHandoffBrief", () => {
  const handoff = parseHandoff(REPLY).handoff;

  it("tells the fresh session it has no memory", () => {
    expect(formatHandoffBrief(handoff)).toContain("no memory of the previous session");
  });

  it("names the task when given one", () => {
    expect(formatHandoffBrief(handoff, { taskName: "Fix dealer mapping" })).toContain(
      'Continuing work on "Fix dealer mapping"',
    );
  });

  it("leads with next step and remaining work, not the file list", () => {
    const brief = formatHandoffBrief(handoff);
    expect(brief.indexOf("Next step")).toBeLessThan(brief.indexOf("Remaining"));
    expect(brief.indexOf("Remaining")).toBeLessThan(brief.indexOf("Files touched"));
  });

  it("carries outstanding verification items across the boundary", () => {
    const brief = formatHandoffBrief(handoff, {
      outstandingChecklist: ["Edit an existing customer", "Run a dealer report"],
    });
    expect(brief).toContain("Outstanding verification");
    expect(brief).toContain("Edit an existing customer");
  });

  it("omits sections that are empty rather than emitting empty headings", () => {
    const brief = formatHandoffBrief({
      summary: "Just started.",
      done: [],
      remaining: [],
      decisions: [],
      filesTouched: [],
    });
    expect(brief).toContain("Just started.");
    expect(brief).not.toContain("## Done");
    expect(brief).not.toContain("## Files");
  });

  it("respects the size cap, because an unbounded brief recreates the problem", () => {
    const bloated: Handoff = {
      summary: "s".repeat(300),
      done: Array.from({ length: 200 }, (_, i) => `done item ${i} ${"x".repeat(60)}`),
      remaining: Array.from({ length: 200 }, (_, i) => `remaining ${i} ${"y".repeat(60)}`),
      decisions: ["a decision"],
      filesTouched: Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`),
      nextStep: "Do the thing.",
    };
    const brief = formatHandoffBrief(bloated, { maxChars: 1200 });
    expect(brief.length).toBeLessThanOrEqual(1200);
    expect(brief).toContain("truncated");
  });

  it("keeps the highest-priority content when truncating", () => {
    const bloated: Handoff = {
      summary: "Short summary.",
      done: Array.from({ length: 100 }, (_, i) => `done ${i} ${"x".repeat(80)}`),
      remaining: ["The one remaining thing"],
      decisions: [],
      filesTouched: [],
      nextStep: "The critical next step",
    };
    const brief = formatHandoffBrief(bloated, { maxChars: 900 });
    expect(brief).toContain("The critical next step");
    expect(brief).toContain("The one remaining thing");
    // The bulky, least load-bearing section is what gets dropped.
    expect(brief).not.toContain("done 99");
  });

  it("hard-caps even when a single section exceeds the budget", () => {
    const brief = formatHandoffBrief(
      { summary: "s".repeat(5000), done: [], remaining: [], decisions: [], filesTouched: [] },
      { maxChars: 200 },
    );
    expect(brief.length).toBeLessThanOrEqual(200);
  });
});

describe("isEmptyHandoff", () => {
  it("detects a handoff not worth resuming from", () => {
    expect(
      isEmptyHandoff({ summary: "  ", done: [], remaining: [], decisions: [], filesTouched: [] }),
    ).toBe(true);
  });

  it("treats a file list alone as empty, since files are re-readable", () => {
    expect(
      isEmptyHandoff({
        summary: "",
        done: [],
        remaining: [],
        decisions: [],
        filesTouched: ["a.ts"],
      }),
    ).toBe(true);
  });

  it("accepts a handoff with any substantive content", () => {
    expect(
      isEmptyHandoff({
        summary: "",
        done: [],
        remaining: [],
        decisions: [],
        filesTouched: [],
        nextStep: "Do X",
      }),
    ).toBe(false);
  });
});

describe("HANDOFF_PROMPT", () => {
  it("asks for what a fresh session cannot re-derive", () => {
    expect(HANDOFF_PROMPT).toContain("could NOT work out by reading the code");
    expect(HANDOFF_PROMPT).toContain("Do not describe the diff");
  });

  it("requests headings the parser recognises", () => {
    const { handoff, structured } = parseHandoff(
      HANDOFF_PROMPT.replace(/^Rules:[\s\S]*$/m, ""),
    );
    expect(structured).toBe(true);
    // Guards against the prompt and parser drifting apart.
    expect(handoff.nextStep !== undefined || handoff.summary.length > 0).toBe(true);
  });
});
