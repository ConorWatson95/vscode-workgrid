import { describe, expect, it } from "vitest";
import { amendmentTitle, upstreamAmendmentNote } from "./upstreamAmendment";

const upstream = {
  stageId: "rc-plan",
  stageName: "Plan",
  finding: "The comparison dropdown must be split into Sales and Purchases.",
};

describe("upstreamAmendmentNote", () => {
  const note = upstreamAmendmentNote(upstream);

  it("names the stage that changed and what changed in it", () => {
    expect(note).toContain('"Plan" was corrected after you ran');
    expect(note).toContain("The comparison dropdown must be split");
  });

  it("is narrowing, because the saving is in what the stage does NOT redo", () => {
    // Left to itself a capable model treats "this changed upstream" as licence to
    // revisit its whole output, which costs what the cold re-run cost and also
    // invalidates the reviews that had already passed the rest.
    expect(note).toMatch(/into line with that change and nothing\s+else/i);
    expect(note).toMatch(/the rest of what you did still stands/i);
  });

  it("asks the stage to say what it left alone, not only what it changed", () => {
    expect(note).toMatch(/what you deliberately left alone/i);
  });

  it("offers the decline route for a change too large to amend", () => {
    expect(note).toMatch(/decline/i);
    expect(note).toMatch(/only a human may choose/i);
  });

  it("names no marker, leaving the protocol to the execution adapter", () => {
    // `correctionPrompt` already states the decline marker. Stating it twice is how
    // the two come to disagree, and the domain has no business naming an engine's
    // protocol at all.
    expect(note).not.toContain("CORRECTION-DECLINED");
  });
});

describe("amendmentTitle", () => {
  it("names the upstream stage rather than numbering the stage's own attempts", () => {
    expect(amendmentTitle("Plan", 1)).toBe('Amend for "Plan"');
  });

  it("numbers repeats, so a stage the ground kept moving under is visible", () => {
    expect(amendmentTitle("Plan", 3)).toBe('Amend for "Plan" (3)');
  });
});
