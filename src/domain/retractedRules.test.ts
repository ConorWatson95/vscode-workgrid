import { describe, expect, it } from "vitest";
import {
  retractedRuleStages,
  removeRetractedStages,
  rulesAreAuthoritative,
  withdrawRetractedItems,
} from "./retractedRules";
import { ReviewRule } from "./reviewRules";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

function item(overrides: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    text: "Open the report",
    checked: false,
    raisedByStage: "r-qa",
    ...overrides,
  };
}

function stage(overrides: Partial<TaskStage> & { id: string }): TaskStage {
  return {
    name: overrides.id,
    kind: "implementation",
    status: "pending",
    intent: "do it",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...overrides,
  };
}

function rule(id: string): ReviewRule {
  return {
    id: `rule-${id}`,
    reason: "SQL objects changed",
    pathPattern: "\\.sql$",
    stage: { id, label: id, kind: "domainReview", intent: "review it" },
  };
}

/** A retracted QA review that already wrote items onto a gate that has not run. */
function pipeline(items: ChecklistItem[]): TaskPipeline {
  return {
    routeId: "report-change",
    stages: [
      stage({ id: "implement" }),
      stage({
        id: "r-qa",
        name: "Runtime QA plan",
        kind: "behaviourReview",
        status: "passed",
        addedByRule: "no automated UI checks",
        checklist: items,
      }),
      stage({ id: "local", kind: "humanVerification" }),
    ],
  };
}

describe("rulesAreAuthoritative", () => {
  it("accepts a config that was read and parsed", () => {
    expect(rulesAreAuthoritative({ sourcePath: "/repo/harness.json", problems: [] })).toBe(true);
  });

  // An unparseable file yields no rules, which reads exactly like every rule having
  // been retracted — so a trailing comma must not empty the repository's checklists.
  it("refuses a config that would not parse", () => {
    expect(
      rulesAreAuthoritative({ sourcePath: "/repo/harness.json", problems: ["not valid JSON"] }),
    ).toBe(false);
  });

  it("refuses a project with no config file at all", () => {
    expect(rulesAreAuthoritative({ problems: [] })).toBe(false);
  });
});

describe("retractedRuleStages", () => {
  it("names a rule-added stage the project no longer declares", () => {
    const retracted = retractedRuleStages(pipeline([item({ id: "a" })]), []);

    expect(retracted).toHaveLength(1);
    expect(retracted[0].stageId).toBe("r-qa");
    expect(retracted[0].rule).toBe("no automated UI checks");
    expect(retracted[0].withdrawable.map((i) => i.id)).toEqual(["a"]);
  });

  it("says nothing about a rule the project still declares", () => {
    expect(retractedRuleStages(pipeline([item({ id: "a" })]), [rule("r-qa")])).toEqual([]);
  });

  it("keeps a ticked item out of the withdrawable set and counts it", () => {
    const retracted = retractedRuleStages(
      pipeline([item({ id: "a" }), item({ id: "b", checked: true })]),
      [],
    );

    expect(retracted[0].withdrawable.map((i) => i.id)).toEqual(["a"]);
    expect(retracted[0].kept).toBe(1);
  });

  // A route stage missing from config is the route having been edited, which
  // `repositionRouteStages` deliberately leaves alone. Only rules are retractable here.
  it("ignores a stage no rule added", () => {
    const route: TaskPipeline = {
      routeId: "report-change",
      stages: [stage({ id: "implement", checklist: [item({ id: "a", raisedByStage: "implement" })] })],
    };

    expect(retractedRuleStages(route, [])).toEqual([]);
  });

  // Reported even with nothing to withdraw: removal still has work to do, and a stage
  // whose only trace is a deferral would otherwise be invisible to it.
  it("reports a retracted stage that raised nothing", () => {
    const quiet: TaskPipeline = {
      routeId: "report-change",
      stages: [stage({ id: "r-sql", kind: "domainReview", addedByRule: "SQL changed" })],
    };

    const retracted = retractedRuleStages(quiet, []);

    expect(retracted).toHaveLength(1);
    expect(retracted[0].withdrawable).toEqual([]);
  });

  // `addedByRule` holds prose, so a rule whose reason was reworded is still declared.
  it("matches on the stage id, never on the recorded reason", () => {
    const reworded: ReviewRule = { ...rule("r-qa"), reason: "something else entirely" };

    expect(retractedRuleStages(pipeline([item({ id: "a" })]), [reworded])).toEqual([]);
  });
});

describe("withdrawRetractedItems", () => {
  it("removes the unchecked items and leaves the stage", () => {
    const before = pipeline([item({ id: "a" }), item({ id: "b", checked: true })]);

    const result = withdrawRetractedItems(before, []);

    expect(result?.pipeline.stages[1].checklist?.map((i) => i.id)).toEqual(["b"]);
    expect(result?.pipeline.stages[1].status).toBe("passed");
    expect(result?.withdrawn[0].withdrawable).toHaveLength(1);
  });

  it("leaves another stage's items alone", () => {
    const mixed = pipeline([
      item({ id: "a" }),
      item({ id: "c", raisedByStage: "local" }),
    ]);

    const result = withdrawRetractedItems(mixed, []);

    expect(result?.pipeline.stages[1].checklist?.map((i) => i.id)).toEqual(["c"]);
  });

  it("reaches an item held on the gate that reads it", () => {
    const elsewhere: TaskPipeline = {
      routeId: "report-change",
      stages: [
        stage({ id: "r-qa", kind: "behaviourReview", addedByRule: "no automated UI checks" }),
        stage({ id: "local", kind: "humanVerification", checklist: [item({ id: "a" })] }),
      ],
    };

    const result = withdrawRetractedItems(elsewhere, []);

    expect(result?.pipeline.stages[1].checklist).toEqual([]);
  });

  it("reports nothing to withdraw when every item is ticked", () => {
    expect(withdrawRetractedItems(pipeline([item({ id: "a", checked: true })]), [])).toBeUndefined();
  });

  it("reports nothing to withdraw when the rule is still declared", () => {
    expect(withdrawRetractedItems(pipeline([item({ id: "a" })]), [rule("r-qa")])).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const before = pipeline([item({ id: "a" })]);

    withdrawRetractedItems(before, []);

    expect(before.stages[1].checklist).toHaveLength(1);
  });
});

describe("removeRetractedStages", () => {
  const AT = "2026-10-01T09:00:00.000Z";

  it("removes the stage and everything it raised, ticks included", () => {
    const before = pipeline([item({ id: "a" }), item({ id: "b", checked: true })]);

    const result = removeRetractedStages(before, [], AT);

    expect(result?.pipeline.stages.map((s) => s.id)).toEqual(["implement", "local"]);
    expect(result?.removed[0].stageId).toBe("r-qa");
    expect(result?.refused).toEqual([]);
  });

  it("takes items it raised off another stage's list", () => {
    const elsewhere: TaskPipeline = {
      routeId: "report-change",
      stages: [
        stage({ id: "r-qa", kind: "behaviourReview", addedByRule: "no automated UI checks" }),
        stage({
          id: "local",
          kind: "humanVerification",
          checklist: [item({ id: "a" }), item({ id: "own", raisedByStage: "local" })],
        }),
      ],
    };

    const result = removeRetractedStages(elsewhere, [], AT);

    expect(result?.pipeline.stages[0].checklist?.map((i) => i.id)).toEqual(["own"]);
  });

  // `outstandingDeferrals` requires the raising stage to be settled, so removing it
  // would make the item quietly stop being outstanding rather than be answered.
  it("settles the deferrals it raised rather than orphaning them", () => {
    const withDeferral: TaskPipeline = {
      ...pipeline([]),
      deferrals: [
        { id: "d1", text: "nobody owns this", raisedByStage: "r-qa", raisedAt: AT },
        { id: "d2", text: "nor this", raisedByStage: "implement", raisedAt: AT },
      ],
    };

    const result = removeRetractedStages(withDeferral, [], AT);

    expect(result?.pipeline.deferrals?.[0].resolved).toBe(true);
    expect(result?.pipeline.deferrals?.[0].resolution).toContain("retracted");
    expect(result?.pipeline.deferrals?.[1].resolved).toBeUndefined();
  });

  it("refuses a stage with a session running in it", () => {
    const running = pipeline([item({ id: "a" })]);
    running.stages[1] = { ...running.stages[1], status: "active" };

    const result = removeRetractedStages(running, [], AT);

    expect(result?.removed).toEqual([]);
    expect(result?.refused[0].reason).toContain("session is running");
    expect(result?.pipeline.stages).toHaveLength(3);
  });

  it("refuses the stage the route is currently on", () => {
    const here: TaskPipeline = { ...pipeline([item({ id: "a" })]), currentStage: "r-qa" };

    const result = removeRetractedStages(here, [], AT);

    expect(result?.refused[0].reason).toContain("currently on it");
  });

  it("leaves a rule the project still declares alone", () => {
    expect(removeRetractedStages(pipeline([item({ id: "a" })]), [rule("r-qa")], AT)).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const before = pipeline([item({ id: "a" })]);

    removeRetractedStages(before, [], AT);

    expect(before.stages).toHaveLength(3);
  });
});
