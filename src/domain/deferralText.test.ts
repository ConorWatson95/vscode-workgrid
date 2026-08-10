import { describe, expect, it } from "vitest";

import { deferralHeadline, isAbridged } from "./deferralText";

describe("deferralHeadline", () => {
  it("returns a short item unchanged", () => {
    expect(deferralHeadline("Nobody creates the rebate lookup table.")).toBe(
      "Nobody creates the rebate lookup table.",
    );
    expect(isAbridged("Nobody creates the rebate lookup table.")).toBe(false);
  });

  it("collapses whitespace", () => {
    expect(deferralHeadline("Two   lines\nof   text")).toBe("Two lines of text");
  });

  it("keeps the first sentence when the item is a paragraph", () => {
    const text =
      "The proc on disk already contains all three fixes. That discrepancy has not " +
      "been reconciled by any stage, and the review cycles disagree about which " +
      "version was reviewed.";
    expect(deferralHeadline(text)).toBe(
      "The proc on disk already contains all three fixes.",
    );
    expect(isAbridged(text)).toBe(true);
  });

  it("does not split on an abbreviation or a version number", () => {
    const text =
      "Verified against CLI 2.1.223 that the proc deploys, but the migration order " +
      "is still undecided and nothing in the route covers writing it down.";
    expect(deferralHeadline(text).startsWith("Verified against CLI 2.1.223 that")).toBe(
      true,
    );
  });

  it("cuts a run-on sentence at a word boundary", () => {
    const text = `the SQL and migration review stages flagged three findings ${"x".repeat(
      20,
    )} double-counted purchases for duplicated Level2Code and narrow ServiceDescriptionCode filters`;
    const headline = deferralHeadline(text);
    expect(headline.length).toBeLessThanOrEqual(110);
    expect(headline.endsWith("…")).toBe(true);
    expect(headline).not.toMatch(/\s…$/);
  });

  it("still truncates when one token fills the budget", () => {
    const headline = deferralHeadline("a".repeat(300));
    expect(headline).toHaveLength(110);
    expect(headline.endsWith("…")).toBe(true);
  });
});
