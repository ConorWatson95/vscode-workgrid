import { describe, expect, it } from "vitest";
import { RankedSuggestion } from "../domain/taskSuggestion";
import { suggestionGroupDescription, suggestionRow } from "./suggestionRow";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

const suggestion = (over: Partial<RankedSuggestion> = {}): RankedSuggestion => ({
  sourceId: "jira",
  ref: "NMGB-2801",
  title: "Scorecard export drops the last row",
  rank: "Major",
  state: "open",
  hidden: false,
  rankIndex: 2,
  ...over,
});

describe("suggestionRow", () => {
  it("leads with the work, not the ticket key", () => {
    // The row is read to decide what to work on; the key is the lookup, not the
    // decision.
    const row = suggestionRow(suggestion());
    expect(row.label).toBe("Scorecard export drops the last row");
    expect(row.description).toBe("NMGB-2801 · Major · open");
  });

  it("omits parts the source did not supply", () => {
    expect(suggestionRow(suggestion({ rank: undefined, state: undefined })).description).toBe(
      "NMGB-2801",
    );
  });

  it("puts the detail and the link in the tooltip", () => {
    const row = suggestionRow(
      suggestion({ detail: "Two dealers reported it.", url: "https://jira/NMGB-2801" }),
    );
    expect(row.tooltip).toContain("Two dealers reported it.");
    expect(row.tooltip).toContain("https://jira/NMGB-2801");
  });

  it("explains why a hidden row is hidden, and that nothing was recorded", () => {
    const row = suggestionRow(suggestion({ hidden: true }));
    expect(row.dimmed).toBe(true);
    expect(row.tooltip).toContain("showFrom");
    expect(row.tooltip).toContain("Nothing is recorded");
  });
});

describe("suggestionGroupDescription", () => {
  it("distinguishes never scanned from nothing found", () => {
    // Opposite facts: one means there is no work, the other that nobody has looked.
    expect(suggestionGroupDescription(0, undefined, NOW, 0)).toBe("not scanned");
    expect(suggestionGroupDescription(0, "2026-08-13T12:00:00.000Z", NOW, 0)).toBe(
      "0 · scanned just now",
    );
  });

  it("ages the list, because an explicit scan is as old as you last asked", () => {
    expect(suggestionGroupDescription(4, "2026-08-13T09:00:00.000Z", NOW, 0)).toBe(
      "4 · scanned 3h ago",
    );
    expect(suggestionGroupDescription(4, "2026-08-11T12:00:00.000Z", NOW, 0)).toBe(
      "4 · scanned 2d ago",
    );
    expect(suggestionGroupDescription(4, "2026-08-13T11:30:00.000Z", NOW, 0)).toBe(
      "4 · scanned 30m ago",
    );
  });

  it("names a failed source on the heading", () => {
    // A scan that failed for one source shows a short list, and a short list is
    // indistinguishable from a quiet board.
    expect(suggestionGroupDescription(2, "2026-08-13T12:00:00.000Z", NOW, 1)).toContain(
      "1 source failed",
    );
    expect(suggestionGroupDescription(2, "2026-08-13T12:00:00.000Z", NOW, 2)).toContain(
      "2 sources failed",
    );
  });

  it("does not invent an age it cannot parse", () => {
    expect(suggestionGroupDescription(1, "nonsense", NOW, 0)).toBe("1 · scanned");
  });
});
