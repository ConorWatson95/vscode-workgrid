import { describe, it, expect } from "vitest";
import {
  applyRules as applyRuleSet,
  approveStage,
  checkOutstandingChecklist,
  createPipeline,
  finishSubtask,
  nextAction,
  outstandingChecklist,
  ruleInsertionIndex,
  recordHandoff,
  handoffsBefore,
  correctStage,
  undoCorrection,
  undoableCorrection,
  recordDeferrals,
  recordActions,
  outstandingDeferrals,
  resolveDeferral,
  holdStageForFindings,
  pipelineProgress,
  planStage,
  answerQuestion,
  clearDenials,
  clearQuestion,
  grantDenial,
  recordDenials,
  ungrantedDenials,
  recordChecklist,
  recordPlanSteps,
  recordStepAccounts,
  unaccountedPlanSteps,
  unexecutedPlanSteps,
  recordQuestion,
  retryStage,
  unansweredQuestions,
  setChecklistItem,
  skipStage,
  revertSubtask,
  recordAssessments,
  assessedAsDone,
  startSubtask,
  SubtaskSpec,
} from "./pipelineEngine";
import { TaskPipeline, TaskStage, normalizePipeline } from "./taskPipeline";
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

  it("puts the review straight after the work, even with no gate to insert before", () => {
    // An adopted ad-hoc pipeline has no terminal gate, so the barrier is the end of
    // the route — but "no later than the end" is not a reason to run last. The
    // review goes where it can first run: once the implementation stage exists.
    const result = applyRules(createPipeline(ROUTE), ["a.sql"]);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "build",
      "sql-review",
      "review",
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

  describe("recordActions", () => {
    it("blocks the raising stage's approval, whatever kind it is", () => {
      // The point of the whole mechanism: a deployment stage is not a
      // humanVerification stage, and its pull request still must not be skipped.
      let pipeline = atGate([]);
      pipeline = recordActions(pipeline, "human-verification", [
        "open https://example.com/pr/1 and merge it",
      ]);
      const result = approveStage(pipeline, "human-verification", T);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.kind).toBe("checklistIncomplete");
      expect(result.ok === false && result.error.message).toContain("for you to do");
    });

    it("lets the stage pass once the step is ticked", () => {
      let pipeline = atGate([]);
      pipeline = recordActions(pipeline, "human-verification", ["open the PR"]);
      const item = pipeline.stages
        .flatMap((s) => s.checklist ?? [])
        .find((i) => i.kind === "action")!;
      pipeline = must(setChecklistItem(pipeline, item.id, { checked: true, at: T }));
      expect(approveStage(pipeline, "human-verification", T).ok).toBe(true);
    });

    it("deduplicates on the text, since a split stage's subtasks each run cold", () => {
      let pipeline = atGate([]);
      pipeline = recordActions(pipeline, "human-verification", ["open the PR"]);
      pipeline = recordActions(pipeline, "human-verification", ["open the PR"]);
      const actions = pipeline.stages
        .flatMap((s) => s.checklist ?? [])
        .filter((i) => i.kind === "action");
      expect(actions).toHaveLength(1);
    });

    it("is not swept up by a bulk verify", () => {
      // Ticking a verification in bulk is a judgement; ticking "I opened the pull
      // request" in bulk is untrue.
      let pipeline = atGate(["Check exports"]);
      pipeline = recordActions(pipeline, "mapping-behaviour-review", ["open the PR"]);
      const result = checkOutstandingChecklist(pipeline, { note: "Bulk", at: T });
      expect(result.checked).toBe(1);
      const action = result.pipeline.stages
        .flatMap((s) => s.checklist ?? [])
        .find((i) => i.kind === "action");
      expect(action?.checked).toBe(false);
    });
  });

  describe("checkOutstandingChecklist", () => {
    it("ticks every outstanding item and reports how many", () => {
      const pipeline = atGate(["Edit an existing customer", "Run a dealer report"]);
      const result = checkOutstandingChecklist(pipeline, { note: "Smoke-tested", at: T });
      expect(result.checked).toBe(2);
      expect(outstandingChecklist(result.pipeline)).toHaveLength(0);
      expect(approveStage(result.pipeline, "human-verification", T).ok).toBe(true);
    });

    it("records the note against every item it ticks", () => {
      // The whole point: an item ticked in bulk must not be indistinguishable in the
      // report from one ticked after actually exercising the behaviour.
      const pipeline = atGate(["Check exports"]);
      const result = checkOutstandingChecklist(pipeline, { note: "Bulk: low risk", at: T });
      const item = result.pipeline.stages
        .flatMap((s) => s.checklist ?? [])
        .find((i) => i.id === "mapping-behaviour-review-c1");
      expect(item?.note).toBe("Bulk: low risk");
      expect(item?.checkedAt).toBe(T);
    });

    it("keeps a note written before the tick and appends the bulk note", () => {
      let pipeline = atGate(["Check exports"]);
      pipeline = must(
        setChecklistItem(pipeline, "mapping-behaviour-review-c1", {
          checked: false,
          note: "Only affects Nissan",
          at: T,
        }),
      );
      const result = checkOutstandingChecklist(pipeline, { note: "Bulk", at: T });
      const item = result.pipeline.stages
        .flatMap((s) => s.checklist ?? [])
        .find((i) => i.id === "mapping-behaviour-review-c1");
      expect(item?.note).toBe("Only affects Nissan — Bulk");
    });

    it("leaves an already-verified item's own note untouched", () => {
      let pipeline = atGate(["Edit an existing customer", "Run a dealer report"]);
      pipeline = must(
        setChecklistItem(pipeline, "mapping-behaviour-review-c1", {
          checked: true,
          note: "Verified on staging",
          at: "2026-08-01T00:00:00.000Z",
        }),
      );
      const result = checkOutstandingChecklist(pipeline, { note: "Bulk", at: T });
      // Only the second item was outstanding.
      expect(result.checked).toBe(1);
      const first = result.pipeline.stages
        .flatMap((s) => s.checklist ?? [])
        .find((i) => i.id === "mapping-behaviour-review-c1");
      expect(first?.note).toBe("Verified on staging");
      expect(first?.checkedAt).toBe("2026-08-01T00:00:00.000Z");
    });

    it("can be scoped to one stage", () => {
      const pipeline = atGate(["Check exports"]);
      const result = checkOutstandingChecklist(pipeline, {
        stageId: "human-verification",
        note: "Bulk",
        at: T,
      });
      // The items belong to the review that raised them, not to the gate.
      expect(result.checked).toBe(0);
      expect(outstandingChecklist(result.pipeline)).toHaveLength(1);
    });

    it("returns the same pipeline when there is nothing outstanding", () => {
      const pipeline = atGate([]);
      const result = checkOutstandingChecklist(pipeline, { note: "Bulk", at: T });
      expect(result.checked).toBe(0);
      expect(result.pipeline).toBe(pipeline);
    });

    it("does not mutate its input", () => {
      const pipeline = atGate(["Check exports"]);
      const before = JSON.parse(JSON.stringify(pipeline));
      checkOutstandingChecklist(pipeline, { note: "Bulk", at: T });
      expect(pipeline).toEqual(before);
    });
  });

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

  /**
   * Two verifications in two environments, which one pooled list could not express.
   *
   * The same change has to be exercised locally against the DEV database — does it
   * behave — and again on the deployed DEV site, which is the only pass that catches
   * configuration, permissions or the deployment itself. Before scopes, the first gate
   * absorbed every item and the second had nothing to ask for, so a route could describe
   * two verifications and only ever perform one.
   */
  describe("two verification gates, scoped", () => {
    const TWO_GATES: RouteDefinition = {
      id: "two-gates",
      label: "Two gates",
      stages: [
        {
          id: "qa",
          label: "QA checklist",
          kind: "behaviourReview",
          intent: "plan it",
          splittable: false,
          gate: "auto",
        },
        {
          id: "local",
          label: "Local verification",
          kind: "humanVerification",
          intent: "run it locally",
          splittable: false,
          gate: "approval",
          checklistScope: "local",
        },
        {
          id: "site",
          label: "DEV site sign-off",
          kind: "humanVerification",
          intent: "open it on DEV",
          splittable: false,
          gate: "approval",
          checklistScope: "dev-site",
        },
      ],
    };

    function scoped(): TaskPipeline {
      let pipeline = must(
        recordChecklist(createPipeline(TWO_GATES), "qa", [
          { text: "Run the report locally", scope: "local" },
          { text: "Open the report on the DEV site", scope: "dev-site" },
        ]),
      );
      // Both gates held, so either can be approved in isolation for the test.
      pipeline = {
        ...pipeline,
        stages: pipeline.stages.map((stage) =>
          stage.kind === "humanVerification"
            ? { ...stage, status: "awaiting-approval" as const }
            : stage,
        ),
      };
      return pipeline;
    }

    it("carries the declared scope onto the stage", () => {
      const pipeline = createPipeline(TWO_GATES);
      expect(pipeline.stages[1].checklistScope).toBe("local");
      expect(pipeline.stages[2].checklistScope).toBe("dev-site");
    });

    it("records the scope a review tagged an item with", () => {
      expect(scoped().stages[0].checklist).toEqual([
        {
          id: "qa-c1",
          text: "Run the report locally",
          checked: false,
          raisedByStage: "qa",
          scope: "local",
        },
        {
          id: "qa-c2",
          text: "Open the report on the DEV site",
          checked: false,
          raisedByStage: "qa",
          scope: "dev-site",
        },
      ]);
    });

    it("blocks each gate only on its own items", () => {
      const pipeline = scoped();

      const local = approveStage(pipeline, "local", T);
      expect(local.ok).toBe(false);
      expect(local.ok === false && local.error.message).toContain("locally");
      expect(local.ok === false && local.error.message).not.toContain("DEV site");

      const site = approveStage(pipeline, "site", T);
      expect(site.ok).toBe(false);
      expect(site.ok === false && site.error.message).toContain("DEV site");
      expect(site.ok === false && site.error.message).not.toContain("locally");
    });

    // The behaviour the whole change exists for: the local gate passes on local
    // evidence, and the site item is still owed.
    it("lets the local gate pass while the site item is still outstanding", () => {
      let pipeline = scoped();
      const localItem = pipeline.stages[0].checklist![0];
      pipeline = must(setChecklistItem(pipeline, localItem.id, { checked: true, at: T }));

      const local = approveStage(pipeline, "local", T);
      expect(local.ok).toBe(true);

      const site = approveStage(must(local), "site", T);
      expect(site.ok).toBe(false);
      expect(site.ok === false && site.error.kind).toBe("checklistIncomplete");
    });

    it("does not let a bulk tick at one gate answer for the other", () => {
      const pipeline = scoped();
      const { pipeline: after, checked } = checkOutstandingChecklist(pipeline, {
        forGate: "local",
        note: "Ran it locally",
        at: T,
      });
      expect(checked).toBe(1);
      const items = after.stages[0].checklist!;
      expect(items.find((i) => i.scope === "local")?.checked).toBe(true);
      expect(items.find((i) => i.scope === "dev-site")?.checked).toBe(false);
    });
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

  it("runs as early as the work allows, not as late as the barrier allows", () => {
    // The expensive half of the old rule. A send-back discards its target and
    // everything after it, so every stage between the work and its review is one
    // thrown away and re-run when the review finds something. Here that is the code
    // review; on the route this came from it was a code review *and* a deployment
    // plan, lost three times over to the same double-counting join.
    const stages = [
      s("write", "implementation"),
      s("review", "codeReview"),
      s("signoff", "humanVerification"),
    ];
    expect(ruleInsertionIndex(stages)).toBe(1);
  });

  it("goes after the last implementation stage, not the first", () => {
    // Routes commonly split the work — the change, then its navigation and
    // permissions. A review spliced between them reviews half a change.
    const stages = [
      s("write", "implementation"),
      s("nav", "implementation"),
      s("build", "test"),
      s("deploy", "deployment"),
    ];
    expect(ruleInsertionIndex(stages)).toBe(2);
  });

  it("puts a checklist-writing review after the deployment, not before it", () => {
    // The inverse of every other review, and the reported problem: a runtime QA
    // checklist raised before anything reached DEV is a list of things nobody can
    // exercise yet, holding the route on items that cannot be ticked.
    const stages = [
      s("write", "implementation"),
      s("deploy-dev", "deployment"),
      s("dev-plan", "planning"),
      s("promote", "deployment"),
    ];
    expect(ruleInsertionIndex(stages, "behaviourReview")).toBe(2);
    // A static review still goes in front of it: whether an object is safe to run is
    // a question worth nothing once it has run.
    expect(ruleInsertionIndex(stages, "domainReview")).toBe(1);
  });

  /**
   * Anchored on the gate that reads the checklist, which is the only position that is
   * right once a route has two kinds of deployment.
   *
   * `report-change` has both: one lands the branch in source control and puts nothing in
   * any environment, the other deploys the SQL. Counting deployments cannot tell them
   * apart, so "after the first deployment" wrote the checklist while the change was
   * half-live — items whose SQL was not yet deployed.
   */
  it("puts a checklist review immediately before the gate that will read it", () => {
    const stages = [
      s("write", "implementation"),
      s("commit", "deployment"), // lands source; nothing observable yet
      s("preview", "test"),
      s("deploy-sql", "deployment"), // now it is live
      s("local-verify", "humanVerification"),
      s("merge", "deployment"),
      s("signoff", "humanVerification"),
    ];
    // Index 4 is immediately before the first gate, so after the SQL is deployed.
    expect(ruleInsertionIndex(stages, "behaviourReview")).toBe(4);
    // A static review still goes in front of anything irreversible.
    expect(ruleInsertionIndex(stages, "domainReview")).toBe(1);
  });

  it("skips a gate that has already passed when placing a checklist review", () => {
    const stages = [
      s("write", "implementation"),
      s("deploy", "deployment"),
      { ...s("local-verify", "humanVerification"), status: "passed" as const },
      s("signoff", "humanVerification"),
    ];
    expect(ruleInsertionIndex(stages, "behaviourReview")).toBe(3);
  });

  it("falls back to the barrier for a checklist stage when nothing deploys", () => {
    // Nothing to wait for, so the ordinary rule applies rather than appending it last.
    const stages = [s("write", "implementation"), s("signoff", "humanVerification")];
    expect(ruleInsertionIndex(stages, "behaviourReview")).toBe(1);
  });

  it("never lands in front of a stage that already ran", () => {
    // Rules are applied mid-run, once a diff exists. The earliest *valid* position
    // is bounded by what has already happened: a pending review spliced before a
    // passed stage would claim an order that never occurred.
    const stages = [
      s("write", "implementation", "passed"),
      s("nav", "implementation", "passed"),
      s("build", "test", "pending"),
      s("deploy", "deployment", "pending"),
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

describe("work a stage declined", () => {
  /** Two stages that act, then one that ships — the shape that failed on live. */
  const route = (): TaskPipeline =>
    ({
      routeId: "r",
      stages: [
        { id: "build", name: "Build", kind: "implementation", status: "passed", intent: "", splittable: false, requiresApproval: false, subtasks: [] },
        { id: "review", name: "Review", kind: "codeReview", status: "passed", intent: "", splittable: false, requiresApproval: false, subtasks: [] },
        { id: "publish", name: "Live publish", kind: "deployment", status: "pending", intent: "", splittable: false, requiresApproval: false, subtasks: [{ id: "publish-1", title: "Publish", prompt: "", status: "pending" }] },
      ],
    }) as TaskPipeline;

  const declined = (text = "the export structure is missing on live") =>
    recordDeferrals(route(), "build", [text], "t1");

  /**
   * An item whose own text names the stage that owns it.
   *
   * `DEFERRED` means work no stage owns — that is what makes the hold in front of a
   * deployment worth stopping for. The prompt says so and nothing checked it, so a DEV
   * preview declined "actually deploying these 3 files to DEV" while naming the
   * "Live publish" stage in the same sentence, and settling it asked a human who owns
   * work whose owner was quoted in the item.
   */
  describe("naming the stage that owns it", () => {
    it("is recorded settled rather than held", () => {
      const p = recordDeferrals(
        route(),
        "build",
        ['actually publishing these files — the "Live publish" stage does it'],
        "t1",
      );
      const item = (p.deferrals ?? [])[0];
      expect(item.resolved).toBe(true);
      expect(item.resolution).toContain("Live publish");
      expect(nextAction(p).kind).not.toBe("deferredWork");
    });

    it("is still recorded, because the observation is real", () => {
      // Dropped, it would vanish entirely: the marker line is stripped out of the
      // report, so the item is the only place it survives.
      const p = recordDeferrals(
        route(),
        "build",
        ['the "Live publish" stage does it'],
        "t1",
      );
      expect(p.deferrals).toHaveLength(1);
    });

    it("leaves an item that names no stage holding the route", () => {
      expect(nextAction(declined()).kind).toBe("deferredWork");
    });
  });

  /**
   * Declines belonging to a run that was thrown away.
   *
   * Re-opening a stage clears its checklist and plan steps because they were raised by
   * a run that no longer exists. Deferrals were only *hidden* by `outstandingDeferrals`
   * while the stage was pending, and came back the moment it passed again — so a real
   * task corrected a stage, watched the four after it re-run and pass, and found the
   * same fourteen items waiting.
   */
  describe("when the run that raised them is discarded", () => {
    /** `correctStage` refuses a stage with nothing to correct, so give it a run. */
    const ranBuild = (p: TaskPipeline): TaskPipeline => ({
      ...p,
      stages: p.stages.map((s) =>
        s.id === "build"
          ? {
              ...s,
              subtasks: [
                {
                  id: "build-1",
                  title: "Build",
                  prompt: "",
                  status: "done" as const,
                  startedAt: "t0",
                  finishedAt: "t1",
                  reply: "built it",
                },
              ],
            }
          : s,
      ),
    });

    it("settles them instead of letting them come back", () => {
      const declinedThen = recordDeferrals(
        route(),
        "review",
        ["the export structure is missing on live"],
        "t1",
      );
      const corrected = correctStage(ranBuild(declinedThen), "build", {
        finding: "wrong cast",
        at: "t2",
      });
      expect(corrected.ok).toBe(true);
      if (!corrected.ok) return;

      const item = (corrected.value.deferrals ?? [])[0];
      expect(item.resolved).toBe(true);
      expect(item.resolution).toContain("discarded");

      // And stays settled once the re-opened stage passes again, which is the failure:
      // hiding it by stage status only deferred the problem.
      const rerun = {
        ...corrected.value,
        stages: corrected.value.stages.map((s) =>
          s.id === "review" ? { ...s, status: "passed" as const } : s,
        ),
      };
      expect(outstandingDeferrals(rerun)).toHaveLength(0);
    });

    it("leaves the corrected stage's own declines alone", () => {
      // A correction keeps everything that stage produced, so what it noticed stands.
      const declinedThen = recordDeferrals(route(), "build", ["a thing nobody owns"], "t1");
      const corrected = correctStage(ranBuild(declinedThen), "build", {
        finding: "wrong cast",
        at: "t2",
      });
      expect(corrected.ok).toBe(true);
      if (!corrected.ok) return;
      expect((corrected.value.deferrals ?? [])[0].resolved).toBeUndefined();
    });
  });

  it("holds the route in front of the stage that ships", () => {
    // The reported failure: a live publish halted on a structure nobody created,
    // several stages after the first agent noticed it was missing.
    const action = nextAction(declined());
    expect(action.kind).toBe("deferredWork");
    expect(action.kind === "deferredWork" && action.stage.id).toBe("publish");
    expect(action.kind === "deferredWork" && action.items[0].raisedByStageName).toBe("Build");
  });

  it("lets a route with no deployment stage run on", () => {
    // Most deferrals are correct and harmless. Holding every stage on one would
    // stop routes constantly, which is how a safety net gets switched off.
    const p = recordDeferrals(
      { ...route(), stages: route().stages.slice(0, 2) } as TaskPipeline,
      "build",
      ["something for later"],
      "t1",
    );
    expect(nextAction(p).kind).toBe("done");
  });

  it("runs the deployment once every item has an owner", () => {
    const settled = resolveDeferral(declined(), "d1", {
      resolution: "Live-only by design; the publish stage creates it.",
      at: "t2",
    });
    expect(settled.ok && nextAction(settled.value).kind).toBe("run");
  });

  it("does not record the same item twice for one stage", () => {
    // A split stage's subtasks each run cold and each notice the same gap; three
    // identical items would read as three separate problems.
    let p = declined();
    p = recordDeferrals(p, "build", ["the export structure is missing on live"], "t2");
    expect(p.deferrals).toHaveLength(1);
  });

  it("treats the same observation reworded as one item", () => {
    // Verbatim from a real task, which carried this fact eleven times. Each stage
    // reworded what it saw and each re-run reworded it again, so exact-text dedup
    // filed every one — and the single item nobody owned was lost among them.
    let p = declined();
    p = recordDeferrals(
      p,
      "build",
      ["`ec-preview.md` is stale relative to the current artifact (Addendum 6 step 61)"],
      "t2",
    );
    const after = p.deferrals!.length;
    p = recordDeferrals(
      p,
      "build",
      ["`ec-preview.md` is stale relative to the current artifact (Addendum 7 step 66)"],
      "t3",
    );
    expect(p.deferrals).toHaveLength(after);
  });

  it("treats one item noticed by two stages as one item", () => {
    // Work does not become different work because a different stage noticed it. Four
    // stages raised the missing verification.sql, each naming a different owner after
    // the dash — which is a disagreement about ownership, not four problems.
    let p = declined();
    p = recordDeferrals(p, "build", ["this project ships no verification.sql"], "t2");
    const after = p.deferrals!.length;
    p = recordDeferrals(
      p,
      "review",
      ["this project ships no verification.sql — owned by \"Runtime QA checklist\""],
      "t3",
    );
    expect(p.deferrals).toHaveLength(after);
  });

  it("still records a genuinely different item", () => {
    // The guard against over-merging: normalising away wording must not merge two
    // real problems, which is worse than listing one twice.
    let p = declined();
    p = recordDeferrals(p, "build", ["the preview is stale"], "t2");
    const after = p.deferrals!.length;
    p = recordDeferrals(p, "build", ["the PRISM loader has the same defect"], "t3");
    expect(p.deferrals).toHaveLength(after + 1);
  });

  it("ignores an item raised by a stage that has been re-opened", () => {
    // Reverting discards what those stages produced, and an observation about a
    // run that no longer exists must not hold a deployment.
    const p = declined();
    const reopened = {
      ...p,
      stages: p.stages.map((s) => (s.id === "build" ? { ...s, status: "pending" } : s)),
    } as TaskPipeline;
    expect(outstandingDeferrals(reopened)).toEqual([]);
  });

  it("keeps the reason rather than deleting the item", () => {
    // The knowledge that was missing when every stage declined it in the first
    // place is exactly this sentence.
    const settled = resolveDeferral(declined(), "d1", { resolution: "Publish owns it.", at: "t2" });
    expect(settled.ok && settled.value.deferrals?.[0]).toMatchObject({
      resolved: true,
      resolution: "Publish owns it.",
      text: "the export structure is missing on live",
    });
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

describe("holdStageForFindings", () => {
  const settled = (status: TaskStage["status"]): TaskPipeline =>
    ({
      routeId: "r",
      stages: [
        { id: "review", name: "SQL review", kind: "domainReview", status, intent: "", splittable: false, requiresApproval: false, subtasks: [], finishedAt: "t0" },
        { id: "deploy", name: "Deploy", kind: "deployment", status: "pending", intent: "", splittable: false, requiresApproval: false, subtasks: [] },
      ],
    }) as TaskPipeline;

  it("holds a review that passed, so the route stops instead of deploying", () => {
    // The reported bug: fourteen critical findings and a clean review were the same
    // outcome to the engine, because a stage passing meant "the session ended".
    const held = holdStageForFindings(settled("passed"), "review", "t1");
    expect(held.ok && held.value.stages[0].status).toBe("awaiting-approval");
    expect(held.ok && held.value.stages[0].finishedAt).toBeUndefined();
  });

  it("leaves a failed stage alone, since it has a louder problem", () => {
    const p = settled("failed");
    const held = holdStageForFindings(p, "review", "t1");
    expect(held.ok && held.value).toBe(p);
  });

  it("leaves a stage already awaiting approval alone", () => {
    const p = settled("awaiting-approval");
    const held = holdStageForFindings(p, "review", "t1");
    expect(held.ok && held.value).toBe(p);
  });

  it("reports an unknown stage rather than silently doing nothing", () => {
    const held = holdStageForFindings(settled("passed"), "nope", "t1");
    expect(held.ok).toBe(false);
  });

  it("makes the engine ask for approval next", () => {
    const held = holdStageForFindings(settled("passed"), "review", "t1");
    expect(held.ok && nextAction(held.value).kind).toBe("awaitApproval");
  });
});

describe("a review that arrives after a deployment has run", () => {
  const stage = (over: Partial<TaskStage>): TaskStage =>
    ({
      id: "s",
      name: "S",
      kind: "implementation",
      status: "pending",
      intent: "",
      splittable: false,
      requiresApproval: false,
      subtasks: [],
      ...over,
    }) as TaskStage;

  const RULES = [
    {
      id: "sql-objects",
      reason: "SQL changed",
      when: { anyPathMatches: ["**/*.sql"] },
      stage: { id: "r-sql", label: "SQL object review", kind: "domainReview", intent: "Review." },
    },
  ] as never;

  it("reports the deployments it could not get in front of", () => {
    // There is nowhere earlier to put it: a pending stage cannot be placed before one
    // that has run. So the fact is reported rather than filed quietly.
    const pipeline = {
      routeId: "sql-quick",
      stages: [
        stage({ id: "change", status: "passed" }),
        stage({ id: "deploy-dev", kind: "deployment", status: "passed" }),
        stage({ id: "deploy-uat", kind: "deployment", status: "passed" }),
        stage({ id: "gate", kind: "humanVerification", status: "pending" }),
      ],
    } as TaskPipeline;

    const result = applyRules(pipeline, ["tools/sql/x.sql"], RULES);
    expect(result.added.map((s) => s.id)).toEqual(["r-sql"]);
    expect(result.deployedAlready.map((s) => s.id)).toEqual(["deploy-dev", "deploy-uat"]);
  });

  it("reports nothing when the review lands in front of every deployment", () => {
    const pipeline = {
      routeId: "sql-quick",
      stages: [
        stage({ id: "change", status: "passed" }),
        stage({ id: "deploy-dev", kind: "deployment", status: "pending" }),
      ],
    } as TaskPipeline;

    const result = applyRules(pipeline, ["tools/sql/x.sql"], RULES);
    expect(result.added.map((s) => s.id)).toEqual(["r-sql"]);
    expect(result.deployedAlready).toEqual([]);
  });
});

describe("mayChangeBranch", () => {
  it("is snapshotted onto the stage from the route", () => {
    // A promotion goes through a PR, so moving the worktree is part of its work; a
    // stage that has run keeps the permission it ran with.
    const route = {
      id: "r",
      label: "R",
      stages: [
        { id: "promote", label: "Promote", kind: "deployment", intent: "i", mayChangeBranch: true },
        { id: "review", label: "Review", kind: "codeReview", intent: "i", gate: "approval" },
      ],
    } as never;
    const pipeline = createPipeline(route);
    expect(pipeline.stages[0].mayChangeBranch).toBe(true);
    expect(pipeline.stages[1].mayChangeBranch).toBeUndefined();
  });
});

describe("plan-step accounting", () => {
  const ROUTE_WITH_PLAN: RouteDefinition = {
    id: "planned",
    label: "Planned",
    description: "d",
    stages: [
      {
        id: "deploy",
        label: "Deploy",
        kind: "deployment",
        intent: "Execute the plan.",
        splittable: false,
        gate: "approval",
        planFile: "docs/plan.md",
      },
    ],
  };

  const STEPS = [
    { number: 1, title: "Ship the migration" },
    { number: 2, title: "Rebuild the KPI elements" },
  ];

  /** A pipeline whose only stage has run and is at its gate. */
  function held(): TaskPipeline {
    let pipeline = createPipeline(ROUTE_WITH_PLAN);
    pipeline = recordPlanSteps(pipeline, "deploy", STEPS);
    const started = startSubtask(pipeline, "deploy-1", { at: T });
    if (started.ok) pipeline = started.value;
    const finished = finishSubtask(pipeline, "deploy-1", { status: "done", at: T });
    if (finished.ok) pipeline = finished.value;
    return pipeline;
  }

  it("snapshots the plan file onto the stage", () => {
    expect(createPipeline(ROUTE_WITH_PLAN).stages[0].planFile).toBe("docs/plan.md");
  });

  it("registers every step as unaccounted for", () => {
    const pipeline = recordPlanSteps(createPipeline(ROUTE_WITH_PLAN), "deploy", STEPS);
    expect(pipeline.stages[0].planSteps).toEqual([
      { number: 1, title: "Ship the migration", status: "unaccounted" },
      { number: 2, title: "Rebuild the KPI elements", status: "unaccounted" },
    ]);
  });

  it("keeps an account when the steps are re-read, and refreshes the title", () => {
    // A stage re-run after a refused tool call must not lose what its first attempt
    // reported, and the plan file may have been edited in between.
    let pipeline = recordPlanSteps(createPipeline(ROUTE_WITH_PLAN), "deploy", STEPS);
    pipeline = recordStepAccounts(pipeline, "deploy", [{ number: 1, state: "done", note: "ran it" }], T);
    pipeline = recordPlanSteps(pipeline, "deploy", [
      { number: 1, title: "Ship the migration (renamed)" },
      { number: 2, title: "Rebuild the KPI elements" },
    ]);

    expect(pipeline.stages[0].planSteps?.[0]).toEqual({
      number: 1,
      title: "Ship the migration (renamed)",
      status: "done",
      note: "ran it",
      at: T,
    });
  });

  it("drops a step the plan no longer contains", () => {
    let pipeline = recordPlanSteps(createPipeline(ROUTE_WITH_PLAN), "deploy", STEPS);
    pipeline = recordPlanSteps(pipeline, "deploy", [STEPS[0]]);
    expect(pipeline.stages[0].planSteps?.map((s) => s.number)).toEqual([1]);
  });

  it("ignores an account for a step the plan does not have", () => {
    let pipeline = recordPlanSteps(createPipeline(ROUTE_WITH_PLAN), "deploy", STEPS);
    pipeline = recordStepAccounts(pipeline, "deploy", [{ number: 9, state: "done" }], T);
    expect(unaccountedPlanSteps(pipeline, "deploy")).toHaveLength(2);
    expect(pipeline.stages[0].planSteps?.map((s) => s.number)).toEqual([1, 2]);
  });

  it("refuses to approve a stage with a step nobody accounted for", () => {
    const result = approveStage(held(), "deploy", T);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("planStepsUnaccounted");
    expect(result.error.message).toContain("docs/plan.md");
    expect(result.error.message).toContain("Rebuild the KPI elements");
  });

  it("approves once every step has an account, including ones reported not done", () => {
    // A step reported not done is a correct answer: it becomes a deferral, which holds
    // the next stage that ships. What cannot pass is silence.
    const pipeline = recordStepAccounts(
      held(),
      "deploy",
      [
        { number: 1, state: "done", note: "ran it" },
        { number: 2, state: "not-done", note: "needs live authorisation" },
      ],
      T,
    );
    const result = approveStage(pipeline, "deploy", T);
    expect(result.ok).toBe(true);
  });

  it("reports the steps a stage said it did not do", () => {
    const pipeline = recordStepAccounts(
      held(),
      "deploy",
      [{ number: 2, state: "not-done", note: "needs live authorisation" }],
      T,
    );
    expect(unexecutedPlanSteps(pipeline).map((e) => e.step.number)).toEqual([2]);
  });

  it("counts nothing outstanding for a skipped stage", () => {
    const skipped = skipStage(held(), "deploy", T);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(unaccountedPlanSteps(skipped.value, "deploy")).toEqual([]);
    expect(unexecutedPlanSteps(skipped.value)).toEqual([]);
  });

  it("survives a round trip through the store", () => {
    // normalizePipeline used to rebuild each stage field by field, so every field added
    // since — verify, verdict, blocked, and these — was dropped on the next read, which
    // turned each hold into one a window reload switched off.
    const pipeline = recordStepAccounts(held(), "deploy", [{ number: 1, state: "done" }], T);
    const restored = normalizePipeline(JSON.parse(JSON.stringify(pipeline)));
    expect(restored?.stages[0].planFile).toBe("docs/plan.md");
    expect(restored?.stages[0].planSteps?.[0].status).toBe("done");
    expect(unaccountedPlanSteps(restored!, "deploy")).toHaveLength(1);
  });

  it("keeps a stage's verify command and its deferrals across a round trip", () => {
    const pipeline = recordDeferrals(
      { ...held(), stages: [{ ...held().stages[0], verify: "dotnet build", verdict: "block" }] },
      "deploy",
      ["the export structure nobody owns"],
      T,
    );
    const restored = normalizePipeline(JSON.parse(JSON.stringify(pipeline)));
    expect(restored?.stages[0].verify).toBe("dotnet build");
    expect(restored?.stages[0].verdict).toBe("block");
    expect(restored?.deferrals).toHaveLength(1);
  });
});

describe("intervention counting", () => {
  // The one measure of the harness's actual goal — supervision per task — that
  // nothing else records. Cost, tokens and latency all fall out of existing state.
  it("counts an approval against the stage approved", () => {
    const pipeline = createPipeline(ROUTE);
    const held = {
      ...pipeline,
      stages: pipeline.stages.map((s) =>
        s.id === "review" ? { ...s, status: "awaiting-approval" as const } : s,
      ),
    };

    const approved = must(approveStage(held, "review", "2026-08-07T09:00:00Z"));
    expect(approved.interventions).toEqual([
      { kind: "approval", stageId: "review", at: "2026-08-07T09:00:00Z" },
    ]);
  });

  it("accumulates one record per human action, in order", () => {
    const pipeline = createPipeline(ROUTE);
    const skipped = must(skipStage(pipeline, "build", "2026-08-07T09:00:00Z"));
    const held = {
      ...skipped,
      stages: skipped.stages.map((s) =>
        s.id === "review" ? { ...s, status: "awaiting-approval" as const } : s,
      ),
    };
    const approved = must(approveStage(held, "review", "2026-08-07T10:00:00Z"));

    expect(approved.interventions?.map((i) => i.kind)).toEqual(["skip", "approval"]);
  });

  // A revert the runner performs by itself is not supervision, and counting it
  // would make a route that retries cleanly look like one needing attention.
  it("records nothing when the caller supplied no timestamp", () => {
    const pipeline = createPipeline(ROUTE);
    const started = must(startSubtask(pipeline, "review-1", "2026-08-07T09:00:00Z"));
    const reverted = must(revertSubtask(started, "review-1"));

    expect(reverted.interventions).toBeUndefined();
  });
});

describe("assessing work that already exists", () => {
  const WITH_ASSESSMENT: RouteDefinition = {
    id: "attached",
    label: "Attached",
    description: "A route attached to work already under way.",
    stages: [
      {
        id: "assess",
        label: "Assess existing work",
        kind: "assessment",
        intent: "Establish what is already done.",
        splittable: false,
        gate: "approval",
      },
      {
        id: "build",
        label: "Build",
        kind: "implementation",
        intent: "Write it.",
        splittable: false,
        gate: "auto",
      },
      {
        id: "review",
        label: "Review",
        kind: "codeReview",
        intent: "Review it.",
        splittable: false,
        gate: "approval",
      },
    ],
  };

  const held = (pipeline: ReturnType<typeof createPipeline>) => ({
    ...pipeline,
    stages: pipeline.stages.map((s) =>
      s.id === "assess" ? { ...s, status: "awaiting-approval" as const } : s,
    ),
  });

  it("records conclusions without acting on them", () => {
    const pipeline = must(
      recordAssessments(createPipeline(WITH_ASSESSMENT), "assess", [
        { stageId: "build", done: true, evidence: "the proc exists" },
      ]),
    );

    // Stored, not applied: a person reads the evidence before stages stop running.
    expect(assessedAsDone(pipeline, "assess")).toHaveLength(1);
    expect(pipeline.stages.find((s) => s.id === "build")?.status).toBe("pending");
  });

  it("skips an assessed stage at the gate, with the evidence and never as passed", () => {
    const recorded = must(
      recordAssessments(createPipeline(WITH_ASSESSMENT), "assess", [
        { stageId: "build", done: true, evidence: "the proc exists" },
        { stageId: "review", done: false, evidence: "no review recorded" },
      ]),
    );
    const approved = must(approveStage(held(recorded), "assess", "2026-08-07T09:00:00Z"));

    const build = approved.stages.find((s) => s.id === "build");
    // Skipped, not passed. A stage that ran has a report and possibly a verify exit
    // code; this has an agent's reading of a diff, and the record must say which.
    expect(build?.status).toBe("skipped");
    expect(build?.skipReason).toContain("the proc exists");
    expect(approved.stages.find((s) => s.id === "review")?.status).toBe("pending");
  });

  it("ignores a conclusion about a stage that has already resolved", () => {
    const base = createPipeline(WITH_ASSESSMENT);
    const withPassed = {
      ...base,
      stages: base.stages.map((s) =>
        s.id === "build" ? { ...s, status: "passed" as const } : s,
      ),
    };

    const recorded = must(
      recordAssessments(withPassed, "assess", [
        { stageId: "build", done: true, evidence: "reading a diff" },
      ]),
    );
    expect(assessedAsDone(recorded, "assess")).toEqual([]);
  });

  it("ignores a conclusion about the assessing stage itself", () => {
    const recorded = must(
      recordAssessments(createPipeline(WITH_ASSESSMENT), "assess", [
        { stageId: "assess", done: true, evidence: "circular" },
      ]),
    );
    expect(assessedAsDone(recorded, "assess")).toEqual([]);
  });

  it("leaves an ordinary approval alone", () => {
    const pipeline = createPipeline(WITH_ASSESSMENT);
    const heldReview = {
      ...pipeline,
      stages: pipeline.stages.map((s) =>
        s.id === "review" ? { ...s, status: "awaiting-approval" as const } : s,
      ),
    };
    const approved = must(approveStage(heldReview, "review", "2026-08-07T09:00:00Z"));
    expect(approved.stages.find((s) => s.id === "build")?.status).toBe("pending");
  });
});

describe("correctStage", () => {
  const ran = (): TaskPipeline =>
    ({
      routeId: "report-change",
      stages: [
        {
          id: "implement", name: "Implement", kind: "implementation", status: "passed",
          intent: "", splittable: false, requiresApproval: false,
          verdict: "pass" as const,
          verification: { command: "npm test", exitCode: 0, at: "t0" },
          subtasks: [{
            id: "implement-1", title: "Implement", prompt: "p", status: "done" as const,
            reply: "Added the grid and the proc.",
            activity: { costUsd: 12.48 },
          }],
        },
        {
          id: "review", name: "Code review", kind: "codeReview", status: "passed",
          intent: "", splittable: false, requiresApproval: false,
          subtasks: [{
            id: "review-1", title: "Review", prompt: "p", status: "done" as const,
            reply: "Looks fine.", activity: { costUsd: 2.49 },
          }],
        },
      ],
    }) as TaskPipeline;

  it("keeps what the stage already did, including its cost", () => {
    // The entire economy of a correction. A revert clears reply and activity, so the
    // fix session rediscovers everything and the record of what the first run cost
    // disappears with it.
    const p = must(correctStage(ran(), "implement", { finding: "wrong cast", at: "t1" }));
    const stage = p.stages[0];
    expect(stage.subtasks[0].reply).toBe("Added the grid and the proc.");
    expect(stage.subtasks[0].activity?.costUsd).toBe(12.48);
    expect(stage.subtasks).toHaveLength(2);
  });

  it("adds the fix as a pending subtask carrying the finding", () => {
    const p = must(correctStage(ran(), "implement", { finding: "wrong cast", at: "t1" }));
    const fix = p.stages[0].subtasks[1];
    expect(fix.status).toBe("pending");
    expect(fix.correction).toMatchObject({ finding: "wrong cast", at: "t1" });
    expect(p.stages[0].status).toBe("pending");
  });

  it("drops the stage's verdict and verification, which were about the old version", () => {
    const p = must(correctStage(ran(), "implement", { finding: "wrong cast", at: "t1" }));
    expect(p.stages[0].verdict).toBeUndefined();
    expect(p.stages[0].verification).toBeUndefined();
  });

  it("snapshots the settlement it drops, so the correction can be withdrawn", () => {
    // None of this is re-derivable: a verdict is what a reviewing session said, and
    // the session is gone. Without the snapshot, a finding that turns out to be wrong
    // costs the cold re-run a correction exists to avoid.
    const p = must(correctStage(ran(), "implement", { finding: "wrong cast", at: "t1" }));
    expect(p.stages[0].subtasks[1].correction?.undo).toEqual({
      status: "passed",
      finishedAt: undefined,
      verdict: "pass",
      verification: { command: "npm test", exitCode: 0, at: "t0" },
      blocked: undefined,
    });
  });

  it("records what re-opening the later stages threw away, as collateral", () => {
    // Without this the cost of a correction was only ever the fix session: the stages
    // it re-opened had their activity cleared and nothing wrote down what they had
    // cost, so "the stages after an implementation one are the cheap ones" was an
    // assertion with no number behind it.
    const p = must(correctStage(ran(), "implement", { finding: "wrong cast", at: "t1" }));
    expect(p.discarded).toEqual([
      expect.objectContaining({
        stageId: "review",
        collateral: true,
        costUsd: 2.49,
        at: "t1",
      }),
    ]);
  });

  it("records nothing for a stage after the target that never ran", () => {
    const withPending = ran();
    const p = must(
      correctStage(
        {
          ...withPending,
          stages: [
            ...withPending.stages,
            {
              id: "deploy", name: "Deploy to DEV", kind: "deployment", status: "pending",
              intent: "", splittable: false, requiresApproval: false, subtasks: [],
            } as unknown as TaskStage,
          ],
        },
        "implement",
        { finding: "wrong cast", at: "t1" },
      ),
    );
    expect(p.discarded?.map((run) => run.stageId)).toEqual(["review"]);
  });

  it("re-opens later stages, which ran against output that is about to change", () => {
    const p = must(correctStage(ran(), "implement", { finding: "wrong cast", at: "t1" }));
    expect(p.stages[1].status).toBe("pending");
    expect(p.stages[1].subtasks[0].reply).toBeUndefined();
  });

  it("numbers corrections, because a second go at one finding is a signal", () => {
    let p = must(correctStage(ran(), "implement", { finding: "wrong cast", at: "t1" }));
    p.stages[0].subtasks[1].status = "done";
    p.stages[0].subtasks[1].reply = "Cast fixed.";
    p = must(correctStage(p, "implement", { finding: "still wrong", at: "t2" }));
    expect(p.stages[0].subtasks.map((s) => s.title)).toEqual([
      "Implement", "Correction 1", "Correction 2",
    ]);
  });

  it("refuses a stage that has produced nothing to correct", () => {
    const fresh = ran();
    fresh.stages[0].subtasks[0].reply = undefined;
    fresh.stages[0].subtasks[0].activity = undefined;
    const result = correctStage(fresh, "implement", { finding: "x", at: "t1" });
    expect(result.ok).toBe(false);
  });

  it("refuses an empty finding, which gives the session nothing to act on", () => {
    expect(correctStage(ran(), "implement", { finding: "   ", at: "t1" }).ok).toBe(false);
  });
});

describe("undoCorrection", () => {
  const ran = (): TaskPipeline =>
    ({
      routeId: "report-change",
      stages: [
        {
          id: "implement", name: "Implement", kind: "implementation", status: "passed",
          intent: "", splittable: false, requiresApproval: false,
          verdict: "pass" as const,
          verification: { command: "npm test", exitCode: 0, at: "t0" },
          finishedAt: "t0",
          subtasks: [{
            id: "implement-1", title: "Implement", prompt: "p", status: "done" as const,
            reply: "Added the grid and the proc.", activity: { costUsd: 12.48 },
          }],
        },
        {
          id: "review", name: "Code review", kind: "codeReview", status: "passed",
          intent: "", splittable: false, requiresApproval: false,
          subtasks: [{
            id: "review-1", title: "Review", prompt: "p", status: "done" as const,
            reply: "Looks fine.", activity: { costUsd: 2.49 },
          }],
        },
      ],
    }) as TaskPipeline;

  const corrected = (): TaskPipeline =>
    must(correctStage(ran(), "implement", { finding: "boss says the grain is wrong", at: "t1" }));

  it("puts back the settlement the correction cleared", () => {
    // The whole point. A finding acted on before it was investigated left a stage
    // that had passed sitting pending with no record it ever had, so withdrawing the
    // finding still cost the cold re-run the correction existed to avoid.
    const p = must(undoCorrection(corrected(), "implement", "t2"));
    const stage = p.stages[0];
    expect(stage.status).toBe("passed");
    expect(stage.verdict).toBe("pass");
    expect(stage.verification).toEqual({ command: "npm test", exitCode: 0, at: "t0" });
    expect(stage.finishedAt).toBe("t0");
  });

  it("removes the correction subtask and keeps the stage's original work", () => {
    const p = must(undoCorrection(corrected(), "implement", "t2"));
    expect(p.stages[0].subtasks).toHaveLength(1);
    expect(p.stages[0].subtasks[0].id).toBe("implement-1");
    expect(p.stages[0].subtasks[0].activity?.costUsd).toBe(12.48);
  });

  it("clears a block the correction's own run left behind", () => {
    // The shape this was actually built for: the correction ran, declined the finding
    // and held the stage. Withdrawing it must take the hold with it, or the route
    // stays stopped on a finding nobody stands behind any more.
    const held = corrected();
    const p = must(
      undoCorrection(
        {
          ...held,
          stages: held.stages.map((s, i) =>
            i === 0 ? { ...s, blocked: "the grain is a product decision" } : s,
          ),
        },
        "implement",
        "t2",
      ),
    );
    expect(p.stages[0].blocked).toBeUndefined();
  });

  it("keeps what the withdrawn correction cost, as a discarded run", () => {
    // A withdrawn correction is money spent on this route. What a route cost is what
    // was spent on it, not what survives on it.
    const held = corrected();
    const withRun = {
      ...held,
      stages: held.stages.map((s, i) =>
        i === 0
          ? {
              ...s,
              subtasks: s.subtasks.map((t) =>
                t.correction ? { ...t, status: "done" as const, activity: { costUsd: 1.4 } } : t,
              ),
            }
          : s,
      ),
    } as TaskPipeline;
    const p = must(undoCorrection(withRun, "implement", "t2"));
    expect(p.discarded).toContainEqual(
      expect.objectContaining({ stageId: "implement", costUsd: 1.4, at: "t2" }),
    );
  });

  it("leaves a stage pending when the correction predates undo snapshots", () => {
    // Guessing a verdict is the one thing this must not do: the operator approves again.
    const old = corrected();
    const stripped = {
      ...old,
      stages: old.stages.map((s, i) =>
        i === 0
          ? {
              ...s,
              subtasks: s.subtasks.map((t) =>
                t.correction ? { ...t, correction: { finding: t.correction.finding, at: "t1" } } : t,
              ),
            }
          : s,
      ),
    } as TaskPipeline;
    const p = must(undoCorrection(stripped, "implement", "t2"));
    expect(p.stages[0].subtasks).toHaveLength(1);
    expect(p.stages[0].status).toBe("awaiting-approval");
    expect(p.stages[0].verdict).toBeUndefined();

    // And the operator can actually act on it. `pending` here was a dead end: every
    // subtask is `done`, so `nextAction` reads the stage as `blocked` and
    // `approveStage` refuses it for not awaiting approval — a fallback whose whole
    // purpose was "approve it again" with no way to approve it.
    expect(nextAction(p)).toMatchObject({ kind: "awaitApproval", stage: { id: "implement" } });
    expect(approveStage(p, "implement", "t3").ok).toBe(true);
  });

  it("withdraws the most recent correction only, so snapshots unwind in order", () => {
    // Each correction snapshotted what the one before it had already cleared, so
    // undoing out of order restores a conclusion a standing correction invalidated.
    const twice = must(
      correctStage(corrected(), "implement", { finding: "and the join", at: "t2" }),
    );
    const p = must(undoCorrection(twice, "implement", "t3"));
    const remaining = p.stages[0].subtasks.filter((s) => s.correction);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].correction?.finding).toBe("boss says the grain is wrong");
    // Still corrected once, so the settlement stays cleared.
    expect(p.stages[0].verdict).toBeUndefined();
  });

  it("does not pretend the later stages it re-opened come back", () => {
    const p = must(undoCorrection(corrected(), "implement", "t2"));
    expect(p.stages[1].status).toBe("pending");
    expect(p.stages[1].subtasks[0].reply).toBeUndefined();
  });

  // The case that made this a defect rather than a nicety, and the reason the
  // re-opening rule is now written once and shared. Correct a plan, let the stages
  // after it apply the corrected plan, then withdraw the correction: those stages hold
  // work built from a plan that no longer exists. Withdrawing changes the stage's
  // output exactly as filing did, so it re-opens them exactly as filing did — even
  // though filing had already re-opened them once and they have since re-run.
  it("re-opens later stages that ran against the correction", () => {
    const applied = corrected();
    const afterRerun = {
      ...applied,
      stages: applied.stages.map((s, i) =>
        i === 1
          ? {
              ...s,
              status: "passed" as const,
              subtasks: [
                {
                  ...s.subtasks[0],
                  status: "done" as const,
                  reply: "Applied the corrected plan.",
                  activity: { costUsd: 3.1 },
                },
              ],
            }
          : s,
      ),
    } as TaskPipeline;

    const p = must(undoCorrection(afterRerun, "implement", "t2"));
    expect(p.stages[1].status).toBe("pending");
    expect(p.stages[1].subtasks[0].reply).toBeUndefined();
    // And what that re-run cost stays on the record, as collateral.
    expect(p.discarded).toContainEqual(
      expect.objectContaining({ stageId: "review", costUsd: 3.1, collateral: true, at: "t2" }),
    );
  });

  it("points the route at the next unresolved stage when the target settles again", () => {
    // The restored stage is `passed`, so parking the route on it would leave a route
    // whose current stage has nothing left to do.
    const p = must(undoCorrection(corrected(), "implement", "t2"));
    expect(p.stages[0].status).toBe("passed");
    expect(p.currentStage).toBe("review");
  });

  it("refuses a stage with no correction", () => {
    expect(undoCorrection(ran(), "implement", "t2").ok).toBe(false);
  });

  it("refuses while the correction is running", () => {
    const running = corrected();
    const mid = {
      ...running,
      stages: running.stages.map((s, i) =>
        i === 0
          ? {
              ...s,
              subtasks: s.subtasks.map((t) =>
                t.correction ? { ...t, status: "active" as const } : t,
              ),
            }
          : s,
      ),
    } as TaskPipeline;
    expect(undoableCorrection(mid.stages[0])).toBeUndefined();
    expect(undoCorrection(mid, "implement", "t2").ok).toBe(false);
  });
});
