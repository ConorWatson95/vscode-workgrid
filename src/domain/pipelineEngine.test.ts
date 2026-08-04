import { describe, it, expect } from "vitest";
import {
  applyRules as applyRuleSet,
  approveStage,
  createPipeline,
  finishSubtask,
  nextAction,
  outstandingChecklist,
  ruleInsertionIndex,
  recordHandoff,
  handoffsBefore,
  pipelineProgress,
  planStage,
  answerQuestion,
  clearDenials,
  clearQuestion,
  grantDenial,
  recordDenials,
  ungrantedDenials,
  recordChecklist,
  recordQuestion,
  retryStage,
  unansweredQuestions,
  setChecklistItem,
  skipStage,
  startSubtask,
  SubtaskSpec,
} from "./pipelineEngine";
import { TaskPipeline, normalizePipeline } from "./taskPipeline";
import { RouteDefinition, findRoute, BUILT_IN_ROUTES } from "./taskRoute";
import { ReviewRule } from "./reviewRules";

const T = "2026-08-03T10:00:00.000Z";

/**
 * Rules local to these tests. The extension ships none, so the engine must be
 * exercised against an explicit set — which also keeps these tests independent
 * of whatever any particular project happens to configure.
 */
const TEST_RULES: readonly ReviewRule[] = [
  {
    id: "sql",
    reason: "SQL or stored procedures changed.",
    pathPattern: "\\.sql$",
    stage: {
      id: "sql-review",
      label: "SQL review",
      kind: "domainReview",
      intent: "Review the SQL.",
    },
  },
  {
    id: "mapping-profile",
    reason: "An object-mapping profile changed.",
    pathPattern: "/mapping/",
    stage: {
      id: "mapping-behaviour-review",
      label: "Mapping behaviour review",
      kind: "behaviourReview",
      intent: "Produce a tester checklist for the mapping change.",
    },
  },
];

/** Applies TEST_RULES unless a case supplies its own set. */
const applyRules = (
  pipeline: TaskPipeline,
  changedPaths: readonly string[],
  rules: readonly ReviewRule[] = TEST_RULES,
) => applyRuleSet(pipeline, changedPaths, rules);

/** Minimal two-stage route: one splittable auto stage, one gated single unit. */
const ROUTE: RouteDefinition = {
  id: "test-route",
  label: "Test route",
  description: "Two stages covering both stage shapes.",
  stages: [
    {
      id: "build",
      label: "Build",
      kind: "implementation",
      intent: "Build it.",
      splittable: true,
      gate: "auto",
    },
    {
      id: "review",
      label: "Review",
      kind: "codeReview",
      intent: "Review it.",
      workflow: "/review",
      splittable: false,
      gate: "approval",
    },
  ],
};

const SPECS: SubtaskSpec[] = [
  { title: "Part one", prompt: "Do part one." },
  { title: "Part two", prompt: "Do part two." },
];

/** Unwraps a Result, failing the test on error rather than silently passing. */
function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.value;
}

describe("createPipeline", () => {
  it("starts every stage pending with no current stage", () => {
    const pipeline = createPipeline(ROUTE);
    expect(pipeline.routeId).toBe("test-route");
    expect(pipeline.stages.map((s) => s.status)).toEqual(["pending", "pending"]);
    expect(pipeline.currentStage).toBeUndefined();
  });

  it("leaves splittable stages empty and synthesizes one subtask for single units", () => {
    const [build, review] = createPipeline(ROUTE).stages;
    expect(build.subtasks).toEqual([]);
    expect(review.subtasks).toHaveLength(1);
    expect(review.subtasks[0]).toMatchObject({
      id: "review-1",
      prompt: "Review it.",
      workflow: "/review",
      status: "pending",
    });
  });

  it("carries the route's gate onto the stage", () => {
    const [build, review] = createPipeline(ROUTE).stages;
    expect(build.requiresApproval).toBe(false);
    expect(review.requiresApproval).toBe(true);
  });
});

describe("nextAction", () => {
  it("asks for a split before an unplanned splittable stage can run", () => {
    const action = nextAction(createPipeline(ROUTE));
    expect(action).toMatchObject({ kind: "split", stage: { id: "build" } });
  });

  it("runs subtasks in order once planned", () => {
    const pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    expect(nextAction(pipeline)).toMatchObject({
      kind: "run",
      subtask: { id: "build-1" },
    });
  });

  it("waits rather than starting a second subtask concurrently", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(startSubtask(pipeline, "build-1", { at: T }));
    expect(nextAction(pipeline)).toMatchObject({
      kind: "running",
      subtask: { id: "build-1" },
    });
  });

  it("moves to the next stage only after the previous one passes", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(startSubtask(pipeline, "build-1", { at: T }));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    // Stage still has build-2 outstanding, so it must not advance.
    expect(nextAction(pipeline)).toMatchObject({ kind: "run", subtask: { id: "build-2" } });

    pipeline = must(finishSubtask(pipeline, "build-2", { status: "done", at: T }));
    expect(nextAction(pipeline)).toMatchObject({ kind: "run", stage: { id: "review" } });
  });

  it("reports done when every stage is resolved", () => {
    const pipeline = must(skipStage(must(skipStage(createPipeline(ROUTE), "build", T)), "review", T));
    expect(nextAction(pipeline)).toEqual({ kind: "done" });
  });
});

describe("planStage", () => {
  it("assigns stable stage-scoped subtask ids", () => {
    const pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    expect(pipeline.stages[0].subtasks.map((s) => s.id)).toEqual(["build-1", "build-2"]);
  });

  it("rejects splitting a single-unit stage", () => {
    const result = planStage(createPipeline(ROUTE), "review", SPECS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe("notSplittable");
  });

  it("rejects an empty split so a stage cannot vanish silently", () => {
    const result = planStage(createPipeline(ROUTE), "build", []);
    expect(result.ok === false && result.error.kind).toBe("emptySplit");
  });

  it("rejects re-planning an already planned stage", () => {
    const pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    const result = planStage(pipeline, "build", SPECS);
    expect(result.ok === false && result.error.kind).toBe("alreadyPlanned");
  });

  it("rejects an unknown stage", () => {
    const result = planStage(createPipeline(ROUTE), "nope", SPECS);
    expect(result.ok === false && result.error.kind).toBe("unknownStage");
  });
});

describe("startSubtask", () => {
  it("activates the stage and records the session", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(startSubtask(pipeline, "build-1", { sessionId: "s1", at: T }));
    expect(pipeline.stages[0].status).toBe("active");
    expect(pipeline.stages[0].startedAt).toBe(T);
    expect(pipeline.stages[0].subtasks[0]).toMatchObject({
      status: "active",
      sessionId: "s1",
      startedAt: T,
    });
    expect(pipeline.currentStage).toBe("build");
  });

  it("keeps the stage's original start time across later subtasks", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(startSubtask(pipeline, "build-1", { at: T }));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    const later = "2026-08-03T12:00:00.000Z";
    pipeline = must(startSubtask(pipeline, "build-2", { at: later }));
    expect(pipeline.stages[0].startedAt).toBe(T);
  });

  it("refuses to start a subtask twice", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(startSubtask(pipeline, "build-1", { at: T }));
    const result = startSubtask(pipeline, "build-1", { at: T });
    expect(result.ok === false && result.error.kind).toBe("alreadyResolved");
  });

  it("rejects an unknown subtask", () => {
    const result = startSubtask(createPipeline(ROUTE), "ghost-1", { at: T });
    expect(result.ok === false && result.error.kind).toBe("unknownSubtask");
  });
});

describe("finishSubtask", () => {
  it("passes an auto-gated stage once its last subtask is done", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    pipeline = must(finishSubtask(pipeline, "build-2", { status: "done", at: T }));
    expect(pipeline.stages[0].status).toBe("passed");
    expect(pipeline.stages[0].finishedAt).toBe(T);
    // A passed stage leaves the pipeline at rest.
    expect(pipeline.currentStage).toBeUndefined();
  });

  it("holds a gated stage at awaiting-approval instead of passing it", () => {
    let pipeline = must(skipStage(createPipeline(ROUTE), "build", T));
    pipeline = must(finishSubtask(pipeline, "review-1", { status: "done", at: T }));
    expect(pipeline.stages[1].status).toBe("awaiting-approval");
    expect(pipeline.currentStage).toBe("review");
    expect(nextAction(pipeline)).toMatchObject({ kind: "awaitApproval" });
  });

  it("fails the stage when any subtask fails, and blocks the route", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    pipeline = must(
      finishSubtask(pipeline, "build-2", { status: "failed", at: T, reason: "tests red" }),
    );
    expect(pipeline.stages[0].status).toBe("failed");
    expect(pipeline.stages[0].subtasks[1].failureReason).toBe("tests red");
    expect(nextAction(pipeline)).toMatchObject({ kind: "blocked", stage: { id: "build" } });
  });

  it("does not settle the stage while subtasks remain", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    expect(pipeline.stages[0].status).toBe("pending");
    expect(pipeline.currentStage).toBe("build");
  });

  it("treats a skipped subtask as resolved without failing the stage", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "skipped", at: T }));
    pipeline = must(finishSubtask(pipeline, "build-2", { status: "done", at: T }));
    expect(pipeline.stages[0].status).toBe("passed");
  });

  it("refuses to re-finish a resolved subtask", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    const result = finishSubtask(pipeline, "build-1", { status: "done", at: T });
    expect(result.ok === false && result.error.kind).toBe("alreadyResolved");
  });
});

describe("approveStage", () => {
  it("passes a gated stage and lets the route continue", () => {
    let pipeline = must(skipStage(createPipeline(ROUTE), "build", T));
    pipeline = must(finishSubtask(pipeline, "review-1", { status: "done", at: T }));
    pipeline = must(approveStage(pipeline, "review", T));
    expect(pipeline.stages[1].status).toBe("passed");
    expect(pipeline.currentStage).toBeUndefined();
    expect(nextAction(pipeline)).toEqual({ kind: "done" });
  });

  it("rejects approving a stage that is not at its gate", () => {
    const result = approveStage(createPipeline(ROUTE), "review", T);
    expect(result.ok === false && result.error.kind).toBe("notAwaitingApproval");
  });
});

describe("skipStage", () => {
  it("skips the stage and its unresolved subtasks", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    pipeline = must(skipStage(pipeline, "build", T));
    expect(pipeline.stages[0].status).toBe("skipped");
    // The already-done subtask keeps its outcome; only the pending one is skipped.
    expect(pipeline.stages[0].subtasks.map((s) => s.status)).toEqual(["done", "skipped"]);
  });

  it("refuses to skip an already resolved stage", () => {
    const pipeline = must(skipStage(createPipeline(ROUTE), "build", T));
    const result = skipStage(pipeline, "build", T);
    expect(result.ok === false && result.error.kind).toBe("alreadyResolved");
  });
});

describe("retryStage", () => {
  it("sends a failed splittable stage back to be re-split", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "failed", at: T }));
    pipeline = must(finishSubtask(pipeline, "build-2", { status: "done", at: T }));
    pipeline = must(retryStage(pipeline, "build"));
    expect(pipeline.stages[0].status).toBe("pending");
    expect(pipeline.stages[0].subtasks).toEqual([]);
    expect(nextAction(pipeline)).toMatchObject({ kind: "split" });
  });

  it("clears run state on a single-unit stage so it can run again", () => {
    let pipeline = must(skipStage(createPipeline(ROUTE), "build", T));
    pipeline = must(startSubtask(pipeline, "review-1", { sessionId: "s1", at: T }));
    pipeline = must(finishSubtask(pipeline, "review-1", { status: "failed", at: T }));
    pipeline = must(retryStage(pipeline, "review"));
    expect(pipeline.stages[1].subtasks[0]).toMatchObject({ status: "pending" });
    expect(pipeline.stages[1].subtasks[0].sessionId).toBeUndefined();
    expect(pipeline.stages[1].subtasks[0].failureReason).toBeUndefined();
    expect(nextAction(pipeline)).toMatchObject({ kind: "run", stage: { id: "review" } });
  });
});

describe("purity", () => {
  it("never mutates the pipeline it is given", () => {
    const original = must(planStage(createPipeline(ROUTE), "build", SPECS));
    const snapshot = JSON.stringify(original);
    must(startSubtask(original, "build-1", { at: T }));
    must(skipStage(original, "build", T));
    must(retryStage(original, "build"));
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("pipelineProgress", () => {
  it("counts resolved stages and subtasks", () => {
    let pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    pipeline = must(finishSubtask(pipeline, "build-1", { status: "done", at: T }));
    pipeline = must(startSubtask(pipeline, "build-2", { at: T }));
    expect(pipelineProgress(pipeline)).toEqual({
      stagesComplete: 0,
      stagesTotal: 2,
      subtasksComplete: 1,
      subtasksTotal: 3,
      checklistOutstanding: 0,
      currentStageName: "Build",
    });
  });

  it("counts skipped stages as complete and reports no current stage at rest", () => {
    const pipeline = must(skipStage(createPipeline(ROUTE), "build", T));
    const progress = pipelineProgress(pipeline);
    expect(progress.stagesComplete).toBe(1);
    expect(progress.currentStageName).toBeUndefined();
  });
});

describe("built-in routes", () => {
  it("drive to completion through split, run, gate and approve", () => {
    const route = findRoute("bug-fix");
    expect(route).toBeDefined();
    let pipeline: TaskPipeline = createPipeline(route!);

    // Guard against a route definition that cannot terminate.
    for (let step = 0; step < 100; step++) {
      const action = nextAction(pipeline);
      if (action.kind === "done") break;
      if (action.kind === "split") {
        pipeline = must(planStage(pipeline, action.stage.id, SPECS));
      } else if (action.kind === "run") {
        pipeline = must(startSubtask(pipeline, action.subtask.id, { at: T }));
        pipeline = must(finishSubtask(pipeline, action.subtask.id, { status: "done", at: T }));
      } else if (action.kind === "awaitApproval") {
        pipeline = must(approveStage(pipeline, action.stage.id, T));
      } else {
        throw new Error(`unexpected action: ${action.kind}`);
      }
    }

    expect(nextAction(pipeline)).toEqual({ kind: "done" });
    expect(pipeline.stages.every((s) => s.status === "passed")).toBe(true);
  });

  it("give every route unique stage ids and a terminal human gate", () => {
    for (const route of BUILT_IN_ROUTES) {
      const ids = route.stages.map((s) => s.id);
      expect(new Set(ids).size, `${route.id} has duplicate stage ids`).toBe(ids.length);
      expect(route.stages.at(-1)?.gate, `${route.id} must end at a gate`).toBe("approval");
    }
  });
});

describe("applyRules", () => {
  /** Route with the terminal gate the rules engine inserts before. */
  const GATED: RouteDefinition = {
    ...ROUTE,
    stages: [
      ROUTE.stages[0],
      {
        id: "human-verification",
        label: "Human verification",
        kind: "humanVerification",
        intent: "Verify by hand.",
        splittable: false,
        gate: "approval",
      },
    ],
  };

  it("adds nothing when the diff matches no rule", () => {
    const pipeline = createPipeline(GATED);
    const result = applyRules(pipeline, ["README.md"]);
    expect(result.added).toEqual([]);
    expect(result.pipeline).toBe(pipeline);
  });

  it("inserts a matched review before the human gate, never after", () => {
    const result = applyRules(createPipeline(GATED), ["db/migrations/001.sql"]);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "build",
      "sql-review",
      "human-verification",
    ]);
  });

  it("adds a behaviour review for a mapping profile change", () => {
    const result = applyRules(createPipeline(GATED), [
      "src/Mapping/CustomerProfile.cs",
    ]);
    const added = result.pipeline.stages.find(
      (s) => s.id === "mapping-behaviour-review",
    );
    expect(added?.kind).toBe("behaviourReview");
    // It raises verification items; the terminal gate is what enforces them.
    expect(added?.requiresApproval).toBe(false);
    expect(added?.addedByRule).toContain("mapping profile");
  });

  it("is idempotent, so a growing diff never duplicates or resets a stage", () => {
    let pipeline = applyRules(createPipeline(GATED), ["a.sql"]).pipeline;
    // The SQL review runs and passes...
    pipeline = must(finishSubtask(pipeline, "sql-review-1", { status: "done", at: T }));
    expect(pipeline.stages.find((s) => s.id === "sql-review")?.status).toBe("passed");

    // ...then more SQL files appear in the diff.
    const again = applyRules(pipeline, ["a.sql", "b.sql"]);
    expect(again.added).toEqual([]);
    expect(again.pipeline.stages.find((s) => s.id === "sql-review")?.status).toBe("passed");
    expect(again.pipeline.stages.filter((s) => s.id === "sql-review")).toHaveLength(1);
  });

  it("reports matched rules even when their stage is already present", () => {
    const first = applyRules(createPipeline(GATED), ["a.sql"]);
    const second = applyRules(first.pipeline, ["a.sql"]);
    expect(second.added).toEqual([]);
    expect(second.matches.map((m) => m.rule.id)).toEqual(["sql"]);
  });

  it("appends at the end when a pipeline has no human gate", () => {
    // An adopted ad-hoc pipeline has no terminal gate to insert before.
    const result = applyRules(createPipeline(ROUTE), ["a.sql"]);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "build",
      "review",
      "sql-review",
    ]);
  });

  it("makes the new stage part of the route the engine drives", () => {
    let pipeline = applyRules(createPipeline(GATED), ["a.sql"]).pipeline;
    pipeline = must(skipStage(pipeline, "build", T));
    expect(nextAction(pipeline)).toMatchObject({ kind: "run", stage: { id: "sql-review" } });
  });

  it("skips a malformed rule instead of throwing", () => {
    const result = applyRules(createPipeline(GATED), ["anything.sql"], [
      { id: "bad", reason: "broken", pathPattern: "([unclosed", stage: {
        id: "never", label: "Never", kind: "domainReview", intent: "x",
      } },
    ]);
    expect(result.added).toEqual([]);
  });
});

describe("checklists", () => {
  const GATED: RouteDefinition = {
    ...ROUTE,
    stages: [
      ROUTE.stages[0],
      {
        id: "human-verification",
        label: "Human verification",
        kind: "humanVerification",
        intent: "Verify by hand.",
        splittable: false,
        gate: "approval",
      },
    ],
  };

  /**
   * Drives a pipeline to its terminal human gate, having passed through a
   * behaviour review that raised `items`. The behaviour review passes on its own
   * (auto gate) — only the final gate weighs the checklist.
   */
  function atGate(items: string[]) {
    let pipeline = applyRules(createPipeline(GATED), [
      "src/Mapping/CustomerProfile.cs",
    ]).pipeline;
    pipeline = must(skipStage(pipeline, "build", T));
    pipeline = must(recordChecklist(pipeline, "mapping-behaviour-review", items));
    pipeline = must(
      finishSubtask(pipeline, "mapping-behaviour-review-1", { status: "done", at: T }),
    );
    expect(pipeline.stages.find((s) => s.id === "mapping-behaviour-review")?.status)
      .toBe("passed");
    pipeline = must(
      finishSubtask(pipeline, "human-verification-1", { status: "done", at: T }),
    );
    return pipeline;
  }

  it("records items against the stage that raised them", () => {
    const pipeline = must(recordChecklist(createPipeline(GATED), "build", ["Check exports"]));
    expect(pipeline.stages[0].checklist).toEqual([
      {
        id: "build-c1",
        text: "Check exports",
        checked: false,
        raisedByStage: "build",
      },
    ]);
  });

  it("replaces its own earlier output when a review re-runs", () => {
    let pipeline = must(recordChecklist(createPipeline(GATED), "build", ["old"]));
    pipeline = must(recordChecklist(pipeline, "build", ["new one", "new two"]));
    expect(pipeline.stages[0].checklist?.map((i) => i.text)).toEqual(["new one", "new two"]);
  });

  it("blocks the human gate while items are outstanding", () => {
    const pipeline = atGate(["Edit an existing customer", "Run a dealer report"]);
    const result = approveStage(pipeline, "human-verification", T);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe("checklistIncomplete");
    expect(result.ok === false && result.error.message).toContain("existing customer");
  });

  it("accumulates items raised by an earlier stage into the final gate", () => {
    // The items belong to the behaviour review, not the gate itself.
    const pipeline = atGate(["Check exports"]);
    expect(pipeline.stages.find((s) => s.id === "human-verification")?.checklist)
      .toBeUndefined();
    expect(outstandingChecklist(pipeline)).toHaveLength(1);
  });

  it("allows the gate once every item is ticked", () => {
    let pipeline = atGate(["Edit an existing customer"]);
    pipeline = must(
      setChecklistItem(pipeline, "mapping-behaviour-review-c1", {
        checked: true,
        note: "Verified on staging",
        at: T,
      }),
    );
    pipeline = must(approveStage(pipeline, "human-verification", T));
    expect(nextAction(pipeline)).toEqual({ kind: "done" });
  });

  it("records the tester's note and tick time", () => {
    let pipeline = atGate(["Check exports"]);
    pipeline = must(
      setChecklistItem(pipeline, "mapping-behaviour-review-c1", {
        checked: true,
        note: "Totals correct",
        at: T,
      }),
    );
    expect(outstandingChecklist(pipeline)).toEqual([]);
    const item = pipeline.stages
      .flatMap((s) => s.checklist ?? [])
      .find((i) => i.id === "mapping-behaviour-review-c1");
    expect(item).toMatchObject({ checked: true, note: "Totals correct", checkedAt: T });
  });

  it("clears the tick time when an item is un-ticked", () => {
    let pipeline = atGate(["Check exports"]);
    const id = "mapping-behaviour-review-c1";
    pipeline = must(setChecklistItem(pipeline, id, { checked: true, at: T }));
    pipeline = must(setChecklistItem(pipeline, id, { checked: false, at: T }));
    const item = pipeline.stages.flatMap((s) => s.checklist ?? []).find((i) => i.id === id);
    expect(item?.checkedAt).toBeUndefined();
    expect(outstandingChecklist(pipeline)).toHaveLength(1);
  });

  it("ignores items from a skipped stage", () => {
    let pipeline = must(recordChecklist(createPipeline(GATED), "build", ["Check exports"]));
    expect(outstandingChecklist(pipeline)).toHaveLength(1);
    pipeline = must(skipStage(pipeline, "build", T));
    expect(outstandingChecklist(pipeline)).toEqual([]);
  });

  it("counts outstanding items in progress", () => {
    const pipeline = atGate(["one", "two"]);
    expect(pipelineProgress(pipeline).checklistOutstanding).toBe(2);
  });

  it("rejects an unknown item or stage", () => {
    const pipeline = createPipeline(GATED);
    expect(
      setChecklistItem(pipeline, "ghost-c1", { checked: true, at: T }).ok,
    ).toBe(false);
    expect(recordChecklist(pipeline, "ghost", ["x"]).ok).toBe(false);
  });
});

describe("normalizePipeline", () => {
  it("upgrades legacy name/status stages to the engine's shape", () => {
    const pipeline = normalizePipeline({
      stages: [{ name: "Implement", status: "active" }],
      currentStage: "Implement",
    });
    expect(pipeline).toEqual({
      routeId: "ad-hoc",
      currentStage: "Implement",
      stages: [
        {
          id: "stage-1",
          name: "Implement",
          kind: "implementation",
          status: "active",
          intent: "Implement",
          splittable: false,
          requiresApproval: false,
          checklist: undefined,
          addedByRule: undefined,
          subtasks: [],
          startedAt: undefined,
          finishedAt: undefined,
        },
      ],
    });
  });

  it("round-trips a current pipeline unchanged", () => {
    const pipeline = must(planStage(createPipeline(ROUTE), "build", SPECS));
    const restored = normalizePipeline(JSON.parse(JSON.stringify(pipeline)));
    expect(restored).toEqual(pipeline);
  });

  it("returns undefined for absent or malformed state", () => {
    expect(normalizePipeline(undefined)).toBeUndefined();
    expect(normalizePipeline({})).toBeUndefined();
    expect(normalizePipeline("nonsense")).toBeUndefined();
  });
});

describe("questions a stage asks", () => {
  /** A pipeline with one question outstanding. */
  function asked(questions: string[] = ["Which tenants?", "Include DR?"]) {
    const pipeline = createPipeline(ROUTE);
    const stage = pipeline.stages[0];
    const result = recordQuestion(pipeline, {
      stageId: stage.id,
      stageName: stage.name,
      subtaskId: `${stage.id}-1`,
      questions,
      at: T,
    });
    if (!result.ok) throw new Error("recordQuestion failed");
    return result.value;
  }

  it("stores one item per question, so each is answered separately", () => {
    const pipeline = asked();
    expect(pipeline.pendingQuestion?.items.map((i) => i.text)).toEqual([
      "Which tenants?",
      "Include DR?",
    ]);
    // Distinct ids are what let an answer be attached to its own question.
    const ids = pipeline.pendingQuestion!.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("drops blank questions rather than rendering an empty field", () => {
    const pipeline = asked(["Which tenants?", "   ", ""]);
    expect(pipeline.pendingQuestion?.items).toHaveLength(1);
  });

  it("refuses a question set with nothing in it", () => {
    const pipeline = createPipeline(ROUTE);
    const result = recordQuestion(pipeline, {
      stageId: pipeline.stages[0].id,
      stageName: "x",
      subtaskId: "x-1",
      questions: ["  "],
      at: T,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a question against a stage that does not exist", () => {
    const result = recordQuestion(createPipeline(ROUTE), {
      stageId: "nope",
      stageName: "x",
      subtaskId: "x-1",
      questions: ["?"],
      at: T,
    });
    expect(result.ok).toBe(false);
  });

  it("answers one question without touching the others", () => {
    const pipeline = asked();
    const first = pipeline.pendingQuestion!.items[0].id;
    const result = answerQuestion(pipeline, first, "Nissan GB only");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pendingQuestion!.items[0].answer).toBe("Nissan GB only");
    expect(result.value.pendingQuestion!.items[1].answer).toBeUndefined();
    expect(unansweredQuestions(result.value).map((i) => i.text)).toEqual(["Include DR?"]);
  });

  it("treats a blank answer as unanswered, so it cannot be submitted", () => {
    const pipeline = asked();
    const id = pipeline.pendingQuestion!.items[0].id;
    const result = answerQuestion(pipeline, id, "   ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(unansweredQuestions(result.value)).toHaveLength(2);
  });

  it("refuses an answer to a question that was not asked", () => {
    expect(answerQuestion(asked(), "made-up", "x").ok).toBe(false);
    expect(answerQuestion(createPipeline(ROUTE), "any", "x").ok).toBe(false);
  });

  it("clears the questions once they are dealt with", () => {
    expect(clearQuestion(asked()).pendingQuestion).toBeUndefined();
    // Idempotent: clearing a pipeline with none is not an error.
    expect(clearQuestion(createPipeline(ROUTE)).pendingQuestion).toBeUndefined();
  });

  it("does not mutate the pipeline it was given", () => {
    const pipeline = asked();
    const before = JSON.stringify(pipeline);
    answerQuestion(pipeline, pipeline.pendingQuestion!.items[0].id, "x");
    clearQuestion(pipeline);
    expect(JSON.stringify(pipeline)).toBe(before);
  });

  it("survives a round-trip through storage", () => {
    // The whole point is that a question outlives the session that asked it, so
    // it has to normalise back out of the persisted blob.
    const stored = JSON.parse(JSON.stringify(asked()));
    const restored = normalizePipeline(stored);
    expect(restored?.pendingQuestion?.items).toHaveLength(2);
    expect(restored?.pendingQuestion?.stageName).toBe(ROUTE.stages[0].label);
  });

  it("upgrades a record that stored one question as a single string", () => {
    const legacy = {
      routeId: "r",
      stages: [],
      pendingQuestion: {
        stageId: "s",
        subtaskId: "s-1",
        question: "Which tenants?",
      },
    };
    const restored = normalizePipeline(legacy);
    expect(restored?.pendingQuestion?.items).toEqual([
      { id: "s-1-q1", text: "Which tenants?", answer: undefined },
    ]);
  });

  it("discards a stored question with nothing to ask", () => {
    const restored = normalizePipeline({
      routeId: "r",
      stages: [],
      pendingQuestion: { stageId: "s", subtaskId: "s-1", items: [] },
    });
    expect(restored?.pendingQuestion).toBeUndefined();
  });
});

describe("tool calls the permission layer refused", () => {
  function refused(count = 2) {
    const pipeline = createPipeline(ROUTE);
    const stage = pipeline.stages[0];
    const items = Array.from({ length: count }, (_, i) => ({
      tool: "PowerShell",
      command: `script${i + 1}.ps1 -Key X`,
      reason: "This command requires approval",
      attempts: i + 1,
      rule: `PowerShell(script${i + 1}.ps1:*)`,
    }));
    const result = recordDenials(pipeline, {
      stageId: stage.id,
      stageName: stage.name,
      subtaskId: `${stage.id}-1`,
      items,
      at: T,
    });
    if (!result.ok) throw new Error("recordDenials failed");
    return result.value;
  }

  it("stores each refusal with the rule that would permit it", () => {
    // The rule is derived from the command actually attempted, which is gone once
    // the session ends — so it is stored rather than re-derived later.
    const pipeline = refused();
    expect(pipeline.pendingDenials?.items.map((i) => i.rule)).toEqual([
      "PowerShell(script1.ps1:*)",
      "PowerShell(script2.ps1:*)",
    ]);
    expect(pipeline.pendingDenials?.items.every((i) => !i.granted)).toBe(true);
  });

  it("gives each refusal its own id", () => {
    const ids = refused(3).pendingDenials!.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("rejects refusals against a stage that does not exist", () => {
    const result = recordDenials(createPipeline(ROUTE), {
      stageId: "nope",
      stageName: "x",
      subtaskId: "x-1",
      items: [{ tool: "Bash", reason: "r", attempts: 1 }],
      at: T,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an empty set", () => {
    const pipeline = createPipeline(ROUTE);
    const result = recordDenials(pipeline, {
      stageId: pipeline.stages[0].id,
      stageName: "x",
      subtaskId: "x-1",
      items: [],
      at: T,
    });
    expect(result.ok).toBe(false);
  });

  it("grants one without granting the rest", () => {
    const pipeline = refused();
    const first = pipeline.pendingDenials!.items[0].id;
    const result = grantDenial(pipeline, first);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pendingDenials!.items[0].granted).toBe(true);
    expect(result.value.pendingDenials!.items[1].granted).toBeUndefined();
    expect(ungrantedDenials(result.value)).toHaveLength(1);
  });

  it("refuses to grant something that was not refused", () => {
    expect(grantDenial(refused(), "made-up").ok).toBe(false);
    expect(grantDenial(createPipeline(ROUTE), "any").ok).toBe(false);
  });

  it("clears them once dealt with", () => {
    expect(clearDenials(refused()).pendingDenials).toBeUndefined();
    expect(clearDenials(createPipeline(ROUTE)).pendingDenials).toBeUndefined();
  });

  it("does not mutate the pipeline it was given", () => {
    const pipeline = refused();
    const before = JSON.stringify(pipeline);
    grantDenial(pipeline, pipeline.pendingDenials!.items[0].id);
    clearDenials(pipeline);
    expect(JSON.stringify(pipeline)).toBe(before);
  });

  it("survives a round-trip through storage", () => {
    // The point of persisting is that a dismissed notification loses nothing, so
    // this has to normalise back out of the stored blob.
    const stored = JSON.parse(JSON.stringify(refused()));
    const restored = normalizePipeline(stored);
    expect(restored?.pendingDenials?.items).toHaveLength(2);
    expect(restored?.pendingDenials?.items[0].rule).toBe("PowerShell(script1.ps1:*)");
    expect(restored?.pendingDenials?.stageName).toBe(ROUTE.stages[0].label);
  });

  it("keeps the granted flag across a round-trip", () => {
    const granted = grantDenial(refused(), refused().pendingDenials!.items[0].id);
    if (!granted.ok) throw new Error("grant failed");
    const restored = normalizePipeline(JSON.parse(JSON.stringify(granted.value)));
    expect(restored?.pendingDenials?.items[0].granted).toBe(true);
  });

  it("discards a stored record with nothing actionable in it", () => {
    expect(
      normalizePipeline({
        routeId: "r",
        stages: [],
        pendingDenials: { stageId: "s", subtaskId: "s-1", items: [] },
      })?.pendingDenials,
    ).toBeUndefined();
  });
});

describe("ruleInsertionIndex", () => {
  const s = (
    id: string,
    kind: TaskStage["kind"],
    status: TaskStage["status"] = "pending",
  ): TaskStage =>
    ({ id, name: id, kind, status, intent: "", splittable: false, requiresApproval: false, subtasks: [] }) as TaskStage;

  it("puts reviews before a deployment, not after it", () => {
    // The reported bug: a route that deploys to DEV before a human signs off had
    // its reviews spliced before the sign-off — so after the deployment. A review
    // of whether SQL is safe to run is worthless once it has run.
    const stages = [
      s("write", "implementation"),
      s("deploy-dev", "deployment"),
      s("verify", "test"),
      s("signoff", "humanVerification"),
    ];
    expect(ruleInsertionIndex(stages)).toBe(1);
  });

  it("falls back to the human gate when the route deploys nothing", () => {
    const stages = [
      s("write", "implementation"),
      s("review", "codeReview"),
      s("signoff", "humanVerification"),
    ];
    expect(ruleInsertionIndex(stages)).toBe(2);
  });

  it("does not insert before a deployment that already happened", () => {
    // Nothing can be got in front of it now, and a pending stage placed before a
    // passed one would describe an order that never occurred.
    const stages = [
      s("write", "implementation", "passed"),
      s("deploy-dev", "deployment", "passed"),
      s("verify", "test", "passed"),
      s("signoff", "humanVerification"),
    ];
    expect(ruleInsertionIndex(stages)).toBe(3);
  });

  it("gets in front of a gate that is waiting right now", () => {
    const stages = [
      s("write", "implementation", "passed"),
      s("signoff", "humanVerification", "awaiting-approval"),
    ];
    expect(ruleInsertionIndex(stages)).toBe(1);
  });

  it("appends when there is no barrier at all", () => {
    expect(ruleInsertionIndex([s("write", "implementation")])).toBe(1);
  });
});

describe("stage handoffs", () => {
  const withHandoff = (): TaskPipeline =>
    ({
      routeId: "r",
      stages: [
        { id: "plan", name: "Plan", kind: "planning", status: "pending", intent: "", splittable: false, requiresApproval: false, handoff: true, subtasks: [] },
        { id: "build", name: "Build", kind: "implementation", status: "pending", intent: "", splittable: false, requiresApproval: false, subtasks: [] },
        { id: "review", name: "Review", kind: "codeReview", status: "pending", intent: "", splittable: false, requiresApproval: false, subtasks: [] },
      ],
    }) as TaskPipeline;

  it("records a conclusion for a stage that opted in", () => {
    const p = recordHandoff(withHandoff(), "plan", "  Put it in apps/, not the overlay.  ", "t1");
    expect(p.handoffs).toEqual([
      { stageId: "plan", stageName: "Plan", text: "Put it in apps/, not the overlay.", at: "t1" },
    ]);
  });

  it("ignores a stage that did not opt in", () => {
    // The fresh session is what makes a stage cheap; carrying every reply forward
    // would rebuild the long conversation the design avoids.
    const p = withHandoff();
    expect(recordHandoff(p, "build", "something", "t1")).toBe(p);
  });

  it("replaces its own earlier entry rather than appending", () => {
    // Otherwise a re-run leaves two versions of the truth for later stages.
    let p = recordHandoff(withHandoff(), "plan", "first", "t1");
    p = recordHandoff(p, "plan", "second", "t2");
    expect(p.handoffs).toHaveLength(1);
    expect(p.handoffs![0].text).toBe("second");
  });

  it("caps a long conclusion and says it did", () => {
    const p = recordHandoff(withHandoff(), "plan", "x".repeat(5000), "t1");
    expect(p.handoffs![0].text.length).toBeLessThan(2000);
    expect(p.handoffs![0].text).toContain("truncated");
  });

  it("ignores an empty conclusion", () => {
    const p = withHandoff();
    expect(recordHandoff(p, "plan", "   ", "t1")).toBe(p);
  });

  it("gives a later stage only what came before it", () => {
    let p = recordHandoff(withHandoff(), "plan", "layering decided", "t1");
    expect(handoffsBefore(p, "review").map((h) => h.stageName)).toEqual(["Plan"]);
    expect(handoffsBefore(p, "plan")).toEqual([]);
  });

  it("orders handoffs by the route, not by when they were recorded", () => {
    // A re-run would otherwise put an early stage's conclusion last.
    const base = withHandoff();
    base.stages[1].handoff = true;
    let p = recordHandoff(base, "build", "built it", "t2");
    p = recordHandoff(p, "plan", "planned it", "t1");
    expect(handoffsBefore(p, "review").map((h) => h.stageName)).toEqual(["Plan", "Build"]);
  });
});
