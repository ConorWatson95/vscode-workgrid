import { describe, expect, it } from "vitest";
import { coverageFromCorrection } from "./correctionCoverage";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

const TEXT = "Change Period and then From in quick succession";

function item(over: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return { text: TEXT, checked: false, raisedByStage: "gate", ...over };
}

function pipeline(over: Partial<TaskStage> = {}): TaskPipeline {
  const stage = {
    id: "gate",
    name: "gate",
    kind: "humanVerification",
    status: "awaiting-approval",
    intent: "",
    gate: "approval",
    subtasks: [],
    checklist: [item({ id: "i1" })],
    checkOutcomes: [{ id: "pyramid-race", passed: true }],
    ...over,
  } as TaskStage;
  return { routeId: "r", stages: [stage], currentStageId: "gate" } as TaskPipeline;
}

describe("coverageFromCorrection", () => {
  it("attaches a check the correction wrote and ran", () => {
    const found = coverageFromCorrection(pipeline(), "gate", `- ${TEXT} [check: pyramid-race]`);
    expect(found.claims).toEqual([
      { itemId: "i1", coveredBy: "pyramid-race", itemText: TEXT },
    ]);
    expect(found.ignored).toEqual([]);
  });

  it("folds whitespace and case, because the line is retyped from a report", () => {
    const reply = `  ${TEXT.toUpperCase().replace(" and ", "   and ")}   [check: PYRAMID-RACE]`;
    expect(coverageFromCorrection(pipeline(), "gate", reply).claims).toHaveLength(1);
  });

  it("refuses a check no run recorded", () => {
    const found = coverageFromCorrection(pipeline(), "gate", `${TEXT} [check: invented]`);
    expect(found.claims).toEqual([]);
    expect(found.ignored[0].why).toBe("no such check");
  });

  it("refuses a paraphrase rather than guessing which item was meant", () => {
    const found = coverageFromCorrection(
      pipeline(),
      "gate",
      "Changing the period quickly [check: pyramid-race]",
    );
    expect(found.claims).toEqual([]);
    expect(found.ignored[0].why).toBe("no such item");
  });

  it("leaves an item that already names a check", () => {
    const already = pipeline({ checklist: [item({ id: "i1", coveredBy: "other" })] });
    const found = coverageFromCorrection(already, "gate", `${TEXT} [check: pyramid-race]`);
    expect(found.claims).toEqual([]);
    expect(found.ignored[0].why).toBe("already covered");
  });

  it("ignores ordinary prose, which is what the rest of the reply is", () => {
    const found = coverageFromCorrection(
      pipeline(),
      "gate",
      "I wrote a flow check for the race and ran it. It passes.",
    );
    expect(found).toEqual({ claims: [], ignored: [] });
  });

  it("claims an item once, however many lines name it", () => {
    const reply = `${TEXT} [check: pyramid-race]\n${TEXT} [check: pyramid-race]`;
    const found = coverageFromCorrection(pipeline(), "gate", reply);
    expect(found.claims).toHaveLength(1);
    expect(found.ignored[0].why).toBe("already covered");
  });
});
