import { describe, expect, it } from "vitest";
import {
  isHidden,
  parseSuggestions,
  rankIndex,
  rankSuggestions,
  startedSuggestionKeys,
  suggestionKey,
  SuggestionSourceOrder,
  TaskSuggestion,
  visibleSuggestions,
  withoutStarted,
} from "./taskSuggestion";

const ORDER: SuggestionSourceOrder = {
  ranks: ["blocker", "critical", "major", "minor", "trivial"],
  showFrom: "major",
  hideStates: ["done", "closed"],
};

const item = (over: Partial<TaskSuggestion> = {}): TaskSuggestion => ({
  sourceId: "jira",
  ref: "NMGB-2801",
  title: "Scorecard export drops the last row",
  ...over,
});

const orderFor = () => ORDER;

describe("suggestionKey", () => {
  it("is the source and its own ref, case-insensitively", () => {
    expect(suggestionKey({ sourceId: "JIRA", ref: " nmgb-2801 " })).toBe("jira::nmgb-2801");
  });

  it("does not change when the title does", () => {
    // Identity is the ref, never the content: a ticket whose title was corrected is
    // not new work.
    expect(suggestionKey(item({ title: "one" }))).toBe(suggestionKey(item({ title: "two" })));
  });
});

describe("rankIndex", () => {
  it("orders by the source's own vocabulary", () => {
    expect(rankIndex(ORDER, "blocker")).toBe(0);
    expect(rankIndex(ORDER, "Major")).toBe(2);
  });

  it("sorts an unrecognised rank last rather than first", () => {
    expect(rankIndex(ORDER, "P0-ish")).toBe(ORDER.ranks.length);
    expect(rankIndex(ORDER, undefined)).toBe(ORDER.ranks.length);
  });
});

describe("isHidden", () => {
  it("hides a rank below the floor", () => {
    expect(isHidden(ORDER, item({ rank: "minor" }))).toBe(true);
    expect(isHidden(ORDER, item({ rank: "trivial" }))).toBe(true);
  });

  it("shows the floor and everything above it", () => {
    expect(isHidden(ORDER, item({ rank: "major" }))).toBe(false);
    expect(isHidden(ORDER, item({ rank: "blocker" }))).toBe(false);
  });

  it("never hides an unrecognised rank", () => {
    // A typo costing an item its place in the order is a nuisance; a typo hiding it
    // loses work.
    expect(isHidden(ORDER, item({ rank: "urgent-ish" }))).toBe(false);
    expect(isHidden(ORDER, item({ rank: undefined }))).toBe(false);
  });

  it("hides a state the source calls finished", () => {
    expect(isHidden(ORDER, item({ rank: "blocker", state: "Done" }))).toBe(true);
    expect(isHidden(ORDER, item({ rank: "blocker", state: "in progress" }))).toBe(false);
  });

  it("hides nothing when showFrom names a rank the source does not declare", () => {
    // The alternative — hiding everything — looks exactly like the board being empty.
    const typo: SuggestionSourceOrder = { ranks: ORDER.ranks, showFrom: "medium" };
    expect(isHidden(typo, item({ rank: "trivial" }))).toBe(false);
  });

  it("hides nothing when the source declares no floor", () => {
    expect(isHidden({ ranks: ORDER.ranks }, item({ rank: "trivial" }))).toBe(false);
  });
});

describe("rankSuggestions", () => {
  it("orders by rank and keeps the source's order within one", () => {
    const ranked = rankSuggestions(
      [
        item({ ref: "A", rank: "minor" }),
        item({ ref: "B", rank: "blocker" }),
        item({ ref: "C", rank: "major" }),
        item({ ref: "D", rank: "blocker" }),
      ],
      orderFor,
    );
    expect(ranked.map((r) => r.ref)).toEqual(["B", "D", "C", "A"]);
  });

  it("deduplicates on the key, keeping the first mention", () => {
    const ranked = rankSuggestions(
      [item({ ref: "A", title: "first" }), item({ ref: "a", title: "second" })],
      orderFor,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].title).toBe("first");
  });

  it("keeps two sources reporting the same ref apart", () => {
    const ranked = rankSuggestions(
      [item({ ref: "A" }), item({ ref: "A", sourceId: "email" })],
      orderFor,
    );
    expect(ranked).toHaveLength(2);
  });

  it("marks hidden items rather than dropping them", () => {
    const ranked = rankSuggestions([item({ ref: "A", rank: "trivial" })], orderFor);
    expect(ranked[0].hidden).toBe(true);
  });

  it("shows everything from a source with no declared order", () => {
    const ranked = rankSuggestions([item({ rank: "trivial" })], () => undefined);
    expect(ranked[0].hidden).toBe(false);
  });
});

describe("visibleSuggestions", () => {
  it("filters hidden items, and brings them all back on request", () => {
    const ranked = rankSuggestions(
      [item({ ref: "A", rank: "blocker" }), item({ ref: "B", rank: "trivial" })],
      orderFor,
    );
    expect(visibleSuggestions(ranked, false).map((r) => r.ref)).toEqual(["A"]);
    expect(visibleSuggestions(ranked, true).map((r) => r.ref)).toEqual(["A", "B"]);
  });
});

describe("withoutStarted", () => {
  it("stops offering work already picked up", () => {
    const ranked = rankSuggestions([item({ ref: "A" }), item({ ref: "B" })], orderFor);
    expect(withoutStarted(ranked, ["jira::a"]).map((r) => r.ref)).toEqual(["B"]);
  });
});

describe("parseSuggestions", () => {
  it("reads ref, rank, state and title", () => {
    const parsed = parseSuggestions(
      "SUGGESTION: NMGB-2801 | major | open | Scorecard export drops the last row",
      "jira",
    );
    expect(parsed).toEqual([
      {
        sourceId: "jira",
        ref: "NMGB-2801",
        rank: "major",
        state: "open",
        title: "Scorecard export drops the last row",
      },
    ]);
  });

  it("takes the title from the last field, so a missing middle costs nothing", () => {
    expect(parseSuggestions("SUGGESTION: NMGB-1 | Fix the thing", "jira")[0]).toEqual({
      sourceId: "jira",
      ref: "NMGB-1",
      title: "Fix the thing",
    });
  });

  it("attaches a url and a detail to the item above", () => {
    const parsed = parseSuggestions(
      [
        "SUGGESTION: NMGB-1 | major | open | Fix the thing",
        "URL: https://jira.example/NMGB-1",
        "DETAIL: Two dealers reported it this week.",
        "SUGGESTION: NMGB-2 | minor | open | Tidy the header",
      ].join("\n"),
      "jira",
    );
    expect(parsed[0].url).toBe("https://jira.example/NMGB-1");
    expect(parsed[0].detail).toBe("Two dealers reported it this week.");
    expect(parsed[1].url).toBeUndefined();
  });

  it("ignores a scan reporting that there is nothing", () => {
    // The same guard deferrals and review findings use. Taken literally this becomes
    // a suggested task called "none" that somebody can click and start.
    expect(parseSuggestions("SUGGESTION: none — the board is clear", "jira")).toEqual([]);
    expect(parseSuggestions("SUGGESTION: NMGB-1 | major | open | none", "jira")).toEqual([]);
  });

  it("drops a line with no title rather than guessing one", () => {
    expect(parseSuggestions("SUGGESTION: NMGB-1", "jira")).toEqual([]);
    expect(parseSuggestions("SUGGESTION:", "jira")).toEqual([]);
  });

  it("reads a bulleted line and ignores prose around it", () => {
    const parsed = parseSuggestions(
      [
        "I looked at the board and found two things worth doing.",
        "- SUGGESTION: NMGB-1 | major | open | Fix the thing",
        "",
        "That is everything assigned to you.",
      ].join("\n"),
      "jira",
    );
    expect(parsed.map((p) => p.ref)).toEqual(["NMGB-1"]);
  });
});

describe("startedSuggestionKeys", () => {
  it("reads the origins of tasks already under way", () => {
    expect(
      startedSuggestionKeys([
        { origin: { sourceId: "jira", ref: "NMGB-1" } },
        {},
        { origin: { sourceId: "JIRA", ref: "nmgb-2" } },
      ]),
    ).toEqual(["jira::nmgb-1", "jira::nmgb-2"]);
  });
});
