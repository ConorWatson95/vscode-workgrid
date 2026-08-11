import { describe, expect, it } from "vitest";
import {
  checklistByGate,
  checklistGates,
  declaredScopes,
  gateFor,
  itemsForGate,
  scopingActive,
  splitScopeTag,
  unassignedItems,
} from "./checklistScope";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

function item(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: overrides.id ?? "i1",
    text: overrides.text ?? "Open the report",
    checked: false,
    raisedByStage: "qa",
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

/** QA writes items; a local gate and a site gate each answer for their own. */
function twoGatePipeline(items: ChecklistItem[]): TaskPipeline {
  return {
    routeId: "report-change",
    stages: [
      stage({ id: "qa", kind: "behaviourReview", checklist: items }),
      stage({ id: "local", kind: "humanVerification", checklistScope: "local" }),
      stage({ id: "site", kind: "humanVerification", checklistScope: "dev-site" }),
    ],
  };
}

/** The shape every existing route has: gates, none of them scoped. */
function unscopedPipeline(items: ChecklistItem[]): TaskPipeline {
  return {
    routeId: "report-change",
    stages: [
      stage({ id: "qa", kind: "behaviourReview", checklist: items }),
      stage({ id: "signoff", kind: "humanVerification" }),
      stage({ id: "uat", kind: "humanVerification" }),
    ],
  };
}

describe("checklistGates", () => {
  it("lists verification gates in route order with what they declared", () => {
    const gates = checklistGates(twoGatePipeline([]));
    expect(gates.map((g) => g.stageId)).toEqual(["local", "site"]);
    expect(gates.map((g) => g.scope)).toEqual(["local", "dev-site"]);
  });

  it("lowercases and trims a declared scope, so config casing cannot miss a match", () => {
    const pipeline = twoGatePipeline([]);
    pipeline.stages[1].checklistScope = "  LOCAL  ";
    expect(checklistGates(pipeline)[0].scope).toBe("local");
  });

  it("treats a blank scope as not declared", () => {
    const pipeline = twoGatePipeline([]);
    pipeline.stages[1].checklistScope = "   ";
    expect(checklistGates(pipeline)[0].scope).toBeUndefined();
  });

  it("marks a passed gate resolved", () => {
    const pipeline = twoGatePipeline([]);
    pipeline.stages[1].status = "passed";
    expect(checklistGates(pipeline).map((g) => g.unresolved)).toEqual([false, true]);
  });
});

describe("scopingActive", () => {
  it("is off when no gate declares a scope", () => {
    expect(scopingActive(checklistGates(unscopedPipeline([])))).toBe(false);
  });

  it("is on as soon as one does", () => {
    expect(scopingActive(checklistGates(twoGatePipeline([])))).toBe(true);
  });
});

/**
 * The compatibility guarantee. Every route that has not opted in must behave exactly
 * as it did before scopes existed: the first unresolved gate answers for everything.
 */
describe("with no scopes declared", () => {
  it("sends every item to the first unresolved gate", () => {
    const pipeline = unscopedPipeline([
      item({ id: "a" }),
      item({ id: "b", scope: "local" }),
    ]);
    expect(itemsForGate(pipeline, "signoff").map((i) => i.id)).toEqual(["a", "b"]);
    expect(itemsForGate(pipeline, "uat")).toEqual([]);
  });

  it("moves to the next gate once the first has passed", () => {
    const pipeline = unscopedPipeline([item({ id: "a" })]);
    pipeline.stages[1].status = "passed";
    expect(itemsForGate(pipeline, "signoff")).toEqual([]);
    expect(itemsForGate(pipeline, "uat").map((i) => i.id)).toEqual(["a"]);
  });
});

describe("with scopes declared", () => {
  it("gives each gate only the items it can answer for", () => {
    const pipeline = twoGatePipeline([
      item({ id: "a", scope: "local", text: "Run it locally" }),
      item({ id: "b", scope: "dev-site", text: "Open it on the DEV site" }),
      item({ id: "c", scope: "local", text: "Export to CSV locally" }),
    ]);
    expect(itemsForGate(pipeline, "local").map((i) => i.id)).toEqual(["a", "c"]);
    expect(itemsForGate(pipeline, "site").map((i) => i.id)).toEqual(["b"]);
  });

  it("matches a scope case-insensitively", () => {
    const pipeline = twoGatePipeline([item({ id: "a", scope: "DEV-Site" })]);
    expect(itemsForGate(pipeline, "site").map((i) => i.id)).toEqual(["a"]);
  });

  it("does not offer a gate items belonging to another", () => {
    const pipeline = twoGatePipeline([item({ id: "a", scope: "dev-site" })]);
    expect(itemsForGate(pipeline, "local")).toEqual([]);
  });

  it("keeps a ticked item out of every gate", () => {
    const pipeline = twoGatePipeline([
      item({ id: "a", scope: "local", checked: true }),
      item({ id: "b", scope: "local" }),
    ]);
    expect(itemsForGate(pipeline, "local").map((i) => i.id)).toEqual(["b"]);
  });

  /**
   * The rule that stops a tagging mistake becoming work nobody verifies. An item is
   * assigned in the wrong place rather than dropped, because the wrong place is a
   * gate where a human sees it and the alternative is silence.
   */
  it("assigns an untagged item to the last scoped gate rather than dropping it", () => {
    const pipeline = twoGatePipeline([item({ id: "a" })]);
    expect(itemsForGate(pipeline, "site").map((i) => i.id)).toEqual(["a"]);
    expect(unassignedItems(pipeline)).toEqual([]);
  });

  it("assigns an item naming a scope this route does not have", () => {
    const pipeline = twoGatePipeline([item({ id: "a", scope: "uat-site" })]);
    expect(itemsForGate(pipeline, "site").map((i) => i.id)).toEqual(["a"]);
    expect(unassignedItems(pipeline)).toEqual([]);
  });

  // Deliberately not the last gate of all: a mistagged item must stay inside the
  // region the route was scoping rather than drifting onto a live sign-off.
  it("uses the last scoped gate, not the last gate", () => {
    const pipeline = twoGatePipeline([item({ id: "a" })]);
    pipeline.stages.push(stage({ id: "live", kind: "humanVerification" }));
    expect(itemsForGate(pipeline, "site").map((i) => i.id)).toEqual(["a"]);
    expect(itemsForGate(pipeline, "live")).toEqual([]);
  });

  /**
   * The hole this closes. A route scopes its DEV gates and leaves UAT and live for later;
   * an item raised after the last scoped gate has passed would be assigned to a closed
   * gate and block nothing — silently unverified, which is exactly what the fallback
   * exists to prevent.
   */
  it("sends an untagged item to the last unresolved scoped gate, not a passed one", () => {
    const pipeline = twoGatePipeline([item({ id: "a" })]);
    pipeline.stages.push(
      stage({ id: "uat", kind: "humanVerification", checklistScope: "uat-site" }),
    );
    pipeline.stages[1].status = "passed";
    pipeline.stages[2].status = "passed";

    expect(itemsForGate(pipeline, "site")).toEqual([]);
    expect(itemsForGate(pipeline, "uat").map((i) => i.id)).toEqual(["a"]);
    expect(unassignedItems(pipeline)).toEqual([]);
  });

  it("falls back to the last scoped gate once every gate has passed", () => {
    const pipeline = twoGatePipeline([item({ id: "a" })]);
    pipeline.stages[1].status = "passed";
    pipeline.stages[2].status = "passed";
    expect(itemsForGate(pipeline, "site").map((i) => i.id)).toEqual(["a"]);
  });

  it("prefers an unresolved gate when a scope is declared twice", () => {
    const pipeline = twoGatePipeline([item({ id: "a", scope: "dev-site" })]);
    pipeline.stages.push(
      stage({ id: "site2", kind: "humanVerification", checklistScope: "dev-site" }),
    );
    pipeline.stages[2].status = "passed";
    expect(itemsForGate(pipeline, "site")).toEqual([]);
    expect(itemsForGate(pipeline, "site2").map((i) => i.id)).toEqual(["a"]);
  });

  it("ignores items on a skipped stage, which gate nothing", () => {
    const pipeline = twoGatePipeline([item({ id: "a", scope: "local" })]);
    pipeline.stages[0].status = "skipped";
    expect(itemsForGate(pipeline, "local")).toEqual([]);
  });

  it("returns nothing for a stage that is not a gate", () => {
    const pipeline = twoGatePipeline([item({ id: "a", scope: "local" })]);
    expect(itemsForGate(pipeline, "qa")).toEqual([]);
  });
});

describe("declaredScopes", () => {
  it("lists the scopes a review may tag with, in order, deduplicated", () => {
    const pipeline = twoGatePipeline([]);
    pipeline.stages.push(
      stage({ id: "site2", kind: "humanVerification", checklistScope: "dev-site" }),
    );
    expect(declaredScopes(pipeline)).toEqual(["local", "dev-site"]);
  });

  it("is empty when nothing opted in", () => {
    expect(declaredScopes(unscopedPipeline([]))).toEqual([]);
  });
});

describe("checklistByGate", () => {
  // A declared gate with nothing to do is worth seeing: the likeliest cause is a
  // review that ignored the scope instruction, and that reads identically to "nothing
  // needed checking there" unless the empty gate is listed.
  it("includes a gate that has nothing assigned to it", () => {
    const pipeline = twoGatePipeline([item({ id: "a", scope: "local" })]);
    const byGate = checklistByGate(pipeline);
    expect(byGate.map((entry) => entry.gate.stageId)).toEqual(["local", "site"]);
    expect(byGate[1].items).toEqual([]);
  });
});

describe("gateFor", () => {
  it("returns nothing when the route has no verification gate", () => {
    const gates = checklistGates({ routeId: "r", stages: [stage({ id: "only" })] });
    expect(gateFor(gates, "local")).toBeUndefined();
  });
});

describe("splitScopeTag", () => {
  const declared = ["local", "dev-site"];

  it("reads a leading tag that names a declared scope", () => {
    expect(splitScopeTag("[local] Run the report locally", declared)).toEqual({
      text: "Run the report locally",
      scope: "local",
    });
  });

  it("accepts parentheses and odd spacing", () => {
    expect(splitScopeTag("(  DEV-Site )  Open it on DEV", declared)).toEqual({
      text: "Open it on DEV",
      scope: "dev-site",
    });
  });

  /**
   * The important negative. A review writing `[Excel]` is describing the item, not
   * naming a gate — stripping that would quietly change what the item says, and this
   * codebase's parsers are matched against what the route declared rather than against
   * anything bracketed.
   */
  it("leaves an unrecognised tag in the text and treats the item as unscoped", () => {
    expect(splitScopeTag("[Excel] Check the export headers", declared)).toEqual({
      text: "[Excel] Check the export headers",
    });
  });

  it("leaves text with no tag alone", () => {
    expect(splitScopeTag("Open the report", declared)).toEqual({
      text: "Open the report",
    });
  });

  it("does not strip a tag that is the whole item", () => {
    expect(splitScopeTag("[local]", declared)).toEqual({ text: "[local]" });
  });

  it("is unscoped when the route declared nothing", () => {
    expect(splitScopeTag("[local] Run it", [])).toEqual({ text: "[local] Run it" });
  });
});
