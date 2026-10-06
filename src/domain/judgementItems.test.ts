import { describe, expect, it } from "vitest";

import { formatJudgement, splitJudgementTag } from "./judgementItems";

describe("splitJudgementTag", () => {
  it("reads the tag and its reason", () => {
    expect(splitJudgementTag("The figures are right [judgement: no baseline is held]")).toEqual({
      text: "The figures are right",
      judgement: "no baseline is held",
    });
  });

  it("reads a bare tag", () => {
    expect(splitJudgementTag("The layout reads well [judgement]")).toEqual({
      text: "The layout reads well",
      judgement: undefined,
    });
  });

  it("accepts the spellings a writer actually produces", () => {
    // Narrow on position and wide on spelling, the rule the scope tag already follows:
    // a tag lost to a plural or a capital is an item that gates the route forever.
    for (const tag of ["[Judgement]", "[judgment]", "[judgements]", "(judgement)", "[JUDGEMENT: x]"]) {
      expect(splitJudgementTag(`An item ${tag}`).text).toBe("An item");
    }
  });

  it("leaves an untagged item exactly as it was", () => {
    expect(splitJudgementTag("Check the export carries the From period")).toEqual({
      text: "Check the export carries the From period",
    });
  });

  it("ignores the word anywhere but the end", () => {
    // Prose about judgement is not a tag. Reading it as one silently removes a real
    // item from the gate, which is the one failure this cannot be allowed to have.
    expect(splitJudgementTag("[judgement] belongs at the end")).toEqual({
      text: "[judgement] belongs at the end",
    });
    expect(splitJudgementTag("Use your judgement on the totals")).toEqual({
      text: "Use your judgement on the totals",
    });
  });

  it("keeps a line that is nothing but a tag", () => {
    // Stripping it would leave an empty item, and an empty item is dropped -- so a
    // mistyped line would vanish rather than being visible as nonsense.
    expect(splitJudgementTag("[judgement]")).toEqual({ text: "[judgement]" });
  });
});

describe("formatJudgement", () => {
  it("states the reason beside the item", () => {
    expect(formatJudgement({ text: "The figures are right", why: "no baseline exists" })).toBe(
      "The figures are right — no baseline exists",
    );
  });

  it("renders a reasonless entry as itself", () => {
    expect(formatJudgement({ text: "The layout reads well" })).toBe("The layout reads well");
  });
});
