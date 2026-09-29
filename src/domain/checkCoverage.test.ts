import { describe, expect, it } from "vitest";
import {
  coverageForGate,
  formatCoverageLine,
  itemsAnsweredByChecks,
  parseCheckResults,
  recordCheckOutcomes,
  splitCheckTag,
  summariseCoverage,
  tickAnsweredItems,
} from "./checkCoverage";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

function item(over: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    text: "something to look at",
    checked: false,
    raisedByStage: "review",
    ...over,
  };
}

function stage(over: Partial<TaskStage> & { id: string }): TaskStage {
  return {
    name: over.id,
    kind: "humanVerification",
    status: "awaiting-approval",
    intent: "",
    gate: "approval",
    subtasks: [],
    ...over,
  } as TaskStage;
}

function pipeline(stages: TaskStage[]): TaskPipeline {
  return { routeId: "r", stages, currentStageId: stages[0]?.id } as TaskPipeline;
}

describe("splitCheckTag", () => {
  it("takes the id off the end and leaves the item", () => {
    expect(splitCheckTag("the Excel export downloads [check: pyramid-export]")).toEqual({
      text: "the Excel export downloads",
      coveredBy: "pyramid-export",
    });
  });

  it("accepts parentheses and an equals sign, because the tag is typed by hand", () => {
    expect(splitCheckTag("x (check = a-b)").coveredBy).toBe("a-b");
  });

  it("leaves an ordinary bracketed aside alone", () => {
    const parsed = splitCheckTag("the export downloads (Excel only)");
    expect(parsed.coveredBy).toBeUndefined();
    expect(parsed.text).toBe("the export downloads (Excel only)");
  });

  it("ignores a tag that is not at the end, so prose cannot be eaten", () => {
    const parsed = splitCheckTag("[check: a] and then look at the totals");
    expect(parsed.coveredBy).toBeUndefined();
  });
});

describe("parseCheckResults", () => {
  it("reads ids and outcomes", () => {
    const text = JSON.stringify({ checks: [{ id: "a", passed: true }, { id: "b", passed: false }] });
    expect(parseCheckResults(text)).toEqual([
      { id: "a", passed: true },
      { id: "b", passed: false },
    ]);
  });

  it("yields nothing at all for anything it cannot read", () => {
    // Each of these becomes a tick if it is guessed at, and a tick asserts a
    // verification happened. Absence of measurement is not permission to act.
    expect(parseCheckResults(undefined)).toEqual([]);
    expect(parseCheckResults("")).toEqual([]);
    expect(parseCheckResults("not json at all")).toEqual([]);
    expect(parseCheckResults(JSON.stringify({ checks: "nope" }))).toEqual([]);
  });

  it("drops an entry whose passed is not a real boolean", () => {
    const text = JSON.stringify({
      checks: [{ id: "a", passed: "true" }, { id: "b" }, { id: "c", passed: true }],
    });
    expect(parseCheckResults(text)).toEqual([{ id: "c", passed: true }]);
  });
});

describe("coverageForGate", () => {
  const gate = () =>
    pipeline([
      stage({
        id: "gate",
        checklist: [
          item({ id: "1", coveredBy: "ran-and-passed" }),
          item({ id: "2", coveredBy: "ran-and-failed" }),
          item({ id: "3", coveredBy: "never-ran" }),
          item({ id: "4" }),
        ],
        checkOutcomes: [
          { id: "ran-and-passed", passed: true },
          { id: "ran-and-failed", passed: false },
        ],
      }),
    ]);

  it("tells the four states apart", () => {
    expect(coverageForGate(gate(), "gate").map((entry) => entry.state)).toEqual([
      "answered",
      "failed",
      "missing",
      "gap",
    ]);
  });

  it("matches ids case- and space-insensitively, since both ends are typed", () => {
    const p = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: " Ran-And-Passed " })],
        checkOutcomes: [{ id: "ran-and-passed", passed: true }],
      }),
    ]);
    expect(coverageForGate(p, "gate")[0].state).toBe("answered");
  });

  it("only offers the passing ones for ticking", () => {
    expect(itemsAnsweredByChecks(gate(), "gate").map((i) => i.id)).toEqual(["1"]);
  });

  it("never offers an action, whatever check claims to cover it", () => {
    const p = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", kind: "action", coveredBy: "c" })],
        checkOutcomes: [{ id: "c", passed: true }],
      }),
    ]);
    expect(itemsAnsweredByChecks(p, "gate")).toEqual([]);
  });
});

describe("tickAnsweredItems", () => {
  it("ticks and marks what did it", () => {
    const before = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: "c" }), item({ id: "2" })],
        checkOutcomes: [{ id: "c", passed: true }],
      }),
    ]);
    const { pipeline: after, ticked } = tickAnsweredItems(before, "gate", "NOW");
    expect(ticked.map((i) => i.id)).toEqual(["1"]);
    const list = after.stages[0].checklist!;
    expect(list[0]).toMatchObject({ checked: true, checkedBy: "check", checkedAt: "NOW" });
    expect(list[1].checked).toBe(false);
  });

  it("leaves the pipeline identical when nothing is answered", () => {
    const before = pipeline([stage({ id: "gate", checklist: [item({ id: "1" })] })]);
    expect(tickAnsweredItems(before, "gate", "NOW").pipeline).toBe(before);
  });

  it("does not untick what a person already ticked", () => {
    const before = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: "c", checked: true, note: "saw it" })],
        checkOutcomes: [{ id: "c", passed: true }],
      }),
    ]);
    const { ticked } = tickAnsweredItems(before, "gate", "NOW");
    expect(ticked).toEqual([]);
  });
});

describe("recordCheckOutcomes", () => {
  it("replaces rather than accumulates, so an older run cannot certify a newer tree", () => {
    const before = pipeline([
      stage({ id: "gate", checkOutcomes: [{ id: "old", passed: true }] }),
    ]);
    const after = recordCheckOutcomes(before, "gate", [{ id: "new", passed: false }]);
    expect(after.stages[0].checkOutcomes).toEqual([{ id: "new", passed: false }]);
  });
});

describe("formatCoverageLine", () => {
  it("says nothing at all when nothing claims coverage", () => {
    const p = pipeline([stage({ id: "gate", checklist: [item({ id: "1" }), item({ id: "2" })] })]);
    expect(formatCoverageLine(summariseCoverage(p, "gate"))).toBeUndefined();
  });

  it("names the gaps once something else is covered", () => {
    const p = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: "c" }), item({ id: "2" })],
        checkOutcomes: [{ id: "c", passed: true }],
      }),
    ]);
    const line = formatCoverageLine(summariseCoverage(p, "gate"))!;
    expect(line).toContain("1 of 2 answered by checks that passed");
    expect(line).toContain("1 with no check behind it");
  });

  it("counts a check that answers no item, since that is the two lists drifting", () => {
    const p = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: "c" })],
        checkOutcomes: [
          { id: "c", passed: true },
          { id: "stray", passed: true },
          { id: "another", passed: false },
        ],
      }),
    ]);
    const summary = summariseCoverage(p, "gate")!;
    expect(summary.orphans).toBe(2);
    expect(formatCoverageLine(summary)!).toContain("2 checks ran that no item names");
  });

  it("says nothing about orphans when every check answers an item", () => {
    const p = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: " C " })],
        checkOutcomes: [{ id: "c", passed: true }],
      }),
    ]);
    const summary = summariseCoverage(p, "gate")!;
    expect(summary.orphans).toBe(0);
    expect(formatCoverageLine(summary)!).not.toContain("no item names");
  });

  it("still counts a check as named once its item is ticked", () => {
    // The tick is the mechanism working. If it turned the check into an orphan, the
    // gate would report drift caused by its own success.
    const p = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: "c", checked: true, checkedBy: "check" })],
        checkOutcomes: [{ id: "c", passed: true }],
      }),
    ]);
    expect(summariseCoverage(p, "gate")!.orphans).toBe(0);
  });

  it("calls out an item naming a check that did not run", () => {
    const p = pipeline([
      stage({
        id: "gate",
        checklist: [item({ id: "1", coveredBy: "gone" }), item({ id: "2", coveredBy: "c" })],
        checkOutcomes: [{ id: "c", passed: true }],
      }),
    ]);
    expect(formatCoverageLine(summariseCoverage(p, "gate"))!).toContain("unverified");
  });
});
