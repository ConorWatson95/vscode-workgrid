import { describe, expect, it } from "vitest";
import {
  resolveAmendmentModel,
  resolveStageModel,
  StageModelSource,
} from "./stageModelResolution";
import { RouteDefinition } from "./taskRoute";
import { ReviewRule } from "./reviewRules";

function route(stages: Array<{ id: string; model?: string }>): RouteDefinition {
  return {
    id: "sql-change",
    label: "SQL change",
    description: "",
    stages: stages.map((s) => ({
      id: s.id,
      label: s.id,
      kind: "implement",
      intent: "do the thing",
      model: s.model,
      gate: s.id === "approve" ? "approval" : "none",
    })) as RouteDefinition["stages"],
  };
}

function rule(stageId: string, model?: string): ReviewRule {
  return {
    id: `rule-${stageId}`,
    description: "",
    when: { pathPatterns: ["**/*.sql"] },
    stage: {
      id: stageId,
      label: stageId,
      kind: "review",
      intent: "review it",
      model,
    },
  } as ReviewRule;
}

const source = (overrides: Partial<StageModelSource> = {}): StageModelSource => ({
  routes: [route([{ id: "sc-plan", model: "sonnet" }, { id: "sc-implement" }])],
  rules: [rule("r-pester", "sonnet")],
  ...overrides,
});

describe("resolveStageModel", () => {
  it("prefers the current config over the model snapshotted at creation", () => {
    // The actual bug: harness.json says sonnet, the stored stage predates the edit.
    const model = resolveStageModel(source(), "sql-change", {
      id: "sc-plan",
      model: undefined,
      addedByRule: undefined,
    });
    expect(model).toBe("sonnet");
  });

  it("clears a stale override when config no longer sets one", () => {
    // Moving a stage back to the default has to take effect too, or the override
    // would be one-way and the only escape would be recreating the task.
    const model = resolveStageModel(source(), "sql-change", {
      id: "sc-implement",
      model: "sonnet",
      addedByRule: undefined,
    });
    expect(model).toBeUndefined();
  });

  it("keeps the snapshot when the stage is no longer in the route", () => {
    // A renamed or removed stage must not silently lose its model; the stage is
    // still going to run, because the pipeline is the source of truth for that.
    const model = resolveStageModel(source(), "sql-change", {
      id: "sc-retired",
      model: "opus",
      addedByRule: undefined,
    });
    expect(model).toBe("opus");
  });

  it("keeps the snapshot when the route itself is gone", () => {
    const model = resolveStageModel(source(), "route-deleted", {
      id: "sc-plan",
      model: "opus",
      addedByRule: undefined,
    });
    expect(model).toBe("opus");
  });

  it("resolves a rule-added stage from the rules, not the route", () => {
    const model = resolveStageModel(source(), "sql-change", {
      id: "r-pester",
      model: undefined,
      addedByRule: "rule-r-pester",
    });
    expect(model).toBe("sonnet");
  });

  it("treats a blank configured model as no override", () => {
    const blank = source({
      routes: [route([{ id: "sc-plan", model: "   " }])],
    });
    const model = resolveStageModel(blank, "sql-change", {
      id: "sc-plan",
      model: "opus",
      addedByRule: undefined,
    });
    expect(model).toBeUndefined();
  });

  it("does not look up a rule stage among routes even when ids collide", () => {
    // A rule stage id that happens to match a route stage id must still resolve
    // from the rule, or a coincidence would silently pick the wrong model.
    const colliding = source({
      routes: [route([{ id: "r-pester", model: "opus" }])],
      rules: [rule("r-pester", "sonnet")],
    });
    const model = resolveStageModel(colliding, "sql-change", {
      id: "r-pester",
      model: undefined,
      addedByRule: "rule-r-pester",
    });
    expect(model).toBe("sonnet");
  });
});

describe("resolveAmendmentModel", () => {
  const amendment = { correction: { upstream: { stageId: "app", stageName: "App" } } };
  const correction = { correction: { finding: "wrong cast", at: "t1" } };
  const plain = {};

  it("runs an amendment on the cheaper model", () => {
    expect(resolveAmendmentModel("sonnet", amendment, "opus")).toBe("sonnet");
  });

  it("never cheapens a correction — that is the stage's own work", () => {
    expect(resolveAmendmentModel("sonnet", correction, "opus")).toBe("opus");
  });

  it("leaves an ordinary subtask alone", () => {
    expect(resolveAmendmentModel("sonnet", plain, "opus")).toBe("opus");
  });

  it("inherits when nothing is configured, so no route changes until it is", () => {
    for (const configured of [undefined, "", "   "]) {
      expect(resolveAmendmentModel(configured, amendment, "opus")).toBe("opus");
    }
  });

  it("passes through an undefined stage model rather than inventing one", () => {
    expect(resolveAmendmentModel(undefined, amendment, undefined)).toBeUndefined();
    expect(resolveAmendmentModel("sonnet", amendment, undefined)).toBe("sonnet");
  });
});
