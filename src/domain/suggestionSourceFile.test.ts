import { describe, expect, it } from "vitest";
import { orderLookup, parseSuggestionSources } from "./suggestionSourceFile";
import { rankSuggestions } from "./taskSuggestion";

const JIRA = {
  id: "jira",
  label: "JIRA",
  scanPrompt: "List the issues assigned to me that are not done.",
  requiredMcpServers: ["atlassian"],
  ranks: ["Blocker", "Critical", "Major", "Minor"],
  showFrom: "Major",
  hideStates: ["Done"],
};

describe("parseSuggestionSources", () => {
  it("reads a source and its order", () => {
    const parsed = parseSuggestionSources([JIRA]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sources[0]).toEqual({
      id: "jira",
      label: "JIRA",
      scanPrompt: "List the issues assigned to me that are not done.",
      requiredMcpServers: ["atlassian"],
      order: {
        ranks: ["Blocker", "Critical", "Major", "Minor"],
        showFrom: "Major",
        hideStates: ["Done"],
      },
    });
  });

  it("requires nothing of a project that declares no sources", () => {
    // The feature is absent rather than guessing at a board, exactly as a project with
    // no rules file is obliged no reviews.
    expect(parseSuggestionSources(undefined)).toEqual({ sources: [], problems: [] });
    expect(parseSuggestionSources([])).toEqual({ sources: [], problems: [] });
  });

  it("falls back to the id when no label is given", () => {
    const parsed = parseSuggestionSources([{ id: "inbox", scanPrompt: "Read it." }]);
    expect(parsed.sources[0].label).toBe("inbox");
  });

  it("rejects a source with no id or no prompt", () => {
    expect(parseSuggestionSources([{ scanPrompt: "x" }]).sources).toHaveLength(0);
    expect(parseSuggestionSources([{ id: "jira" }]).sources).toHaveLength(0);
    expect(parseSuggestionSources([{ id: "jira" }]).problems[0]).toContain("scanPrompt");
  });

  it("keeps the first of two sources sharing an id", () => {
    const parsed = parseSuggestionSources([
      { id: "jira", scanPrompt: "first" },
      { id: "JIRA", scanPrompt: "second" },
    ]);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0].scanPrompt).toBe("first");
    expect(parsed.problems[0]).toContain("duplicate");
  });

  it("rejects a floor that names a rank the source does not declare", () => {
    // It would hide nothing, so the source silently behaves as though the setting were
    // absent — and a longer list than you asked for looks like a busy board.
    const parsed = parseSuggestionSources([{ ...JIRA, showFrom: "Medium" }]);
    expect(parsed.sources).toHaveLength(0);
    expect(parsed.problems[0]).toContain("Medium");
  });

  it("rejects malformed arrays rather than half-reading them", () => {
    expect(parseSuggestionSources([{ ...JIRA, ranks: "Major" }]).problems[0]).toContain("ranks");
    expect(
      parseSuggestionSources([{ ...JIRA, requiredMcpServers: [1] }]).problems[0],
    ).toContain("requiredMcpServers");
    expect(parseSuggestionSources([{ ...JIRA, hideStates: {} }]).problems[0]).toContain(
      "hideStates",
    );
  });

  it("keeps the good sources when one is bad", () => {
    const parsed = parseSuggestionSources([{ id: "bad" }, JIRA]);
    expect(parsed.sources.map((s) => s.id)).toEqual(["jira"]);
    expect(parsed.problems).toHaveLength(1);
  });

  it("reports a suggestions field that is not an array", () => {
    expect(parseSuggestionSources({ jira: JIRA }).problems[0]).toContain("must be an array");
  });

  it("keeps a source's own ref shape", () => {
    // A ref is opaque to the runtime, so its shape belongs to the source. The built-in
    // JIRA shape is a default, not an assumption.
    const parsed = parseSuggestionSources([{ ...JIRA, refPattern: "[0-9]+" }]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sources[0].refPattern).toBe("[0-9]+");
  });

  it("rejects a refPattern that does not compile", () => {
    // Ignored, it would fall back to the JIRA shape — so the source appears to work while
    // refusing every ref that is not JIRA-shaped, and the author's evidence is a
    // rejection of a ticket they can see on their own board.
    const parsed = parseSuggestionSources([{ ...JIRA, refPattern: "([unclosed" }]);
    expect(parsed.sources).toEqual([]);
    expect(parsed.problems[0]).toContain("not a valid regular expression");
  });

  it("leaves refPattern absent when nothing declares one", () => {
    expect(parseSuggestionSources([JIRA]).sources[0].refPattern).toBeUndefined();
  });
});

describe("orderLookup", () => {
  it("gives each source its own vocabulary", () => {
    const { sources } = parseSuggestionSources([
      JIRA,
      { id: "inbox", scanPrompt: "Read it.", ranks: ["Action", "FYI"], showFrom: "Action" },
    ]);
    const ranked = rankSuggestions(
      [
        { sourceId: "inbox", ref: "m1", rank: "FYI", title: "Newsletter" },
        { sourceId: "jira", ref: "NMGB-1", rank: "Blocker", title: "Broken export" },
      ],
      orderLookup(sources),
    );
    // Two vocabularies, neither mapped onto the other: each item is ranked and hidden
    // by its own source's rules.
    expect(ranked.map((r) => r.ref)).toEqual(["NMGB-1", "m1"]);
    expect(ranked.find((r) => r.ref === "m1")?.hidden).toBe(true);
    expect(ranked.find((r) => r.ref === "NMGB-1")?.hidden).toBe(false);
  });

  it("returns nothing for a source that is not configured", () => {
    expect(orderLookup([])("jira")).toBeUndefined();
  });
});
