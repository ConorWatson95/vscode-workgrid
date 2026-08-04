import { describe, expect, it } from "vitest";
import { refreshPendingStages, revertToStage } from "./stageRefresh";
import { TaskPipeline, TaskStage } from "./taskPipeline";
import { RouteDefinition } from "./taskRoute";
import { ReviewRule } from "./reviewRules";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "deploy",
    name: "Deploy",
    kind: "implement",
    status: "pending",
    intent: "Run the deployment.",
    splittable: false,
    requiresApproval: false,
    subtasks: [
      {
        id: "deploy-1",
        title: "Deploy",
        prompt: "Run the deployment.",
        status: "pending",
      },
    ],
    ...overrides,
  } as TaskStage;
}

function pipeline(stages: TaskStage[]): TaskPipeline {
  return { routeId: "sql-change", stages };
}

const route = (
  stages: Array<{ id: string; intent: string; model?: string }>,
): RouteDefinition =>
  ({
    id: "sql-change",
    label: "SQL change",
    description: "",
    stages: stages.map((s) => ({
      id: s.id,
      label: s.id,
      kind: "implement",
      intent: s.intent,
      model: s.model,
      gate: "approval",
    })),
  }) as RouteDefinition;

const source = (
  stages: Array<{ id: string; intent: string; model?: string }>,
  rules: ReviewRule[] = [],
) => ({ routes: [route(stages)], rules });

describe("refreshPendingStages", () => {
  it("brings a not-yet-started stage's intent up to date", () => {
    // The reported case: a deploy intent that omitted -Project, fixed in config.
    const result = refreshPendingStages(
      pipeline([stage()]),
      source([{ id: "deploy", intent: "Run the deployment with -Project X." }]),
    );
    expect(result.changed).toEqual(["deploy"]);
    expect(result.pipeline.stages[0].intent).toBe("Run the deployment with -Project X.");
  });

  it("updates the subtask prompt derived from that intent", () => {
    // Otherwise the stage carries the new intent but still runs the old prompt.
    const result = refreshPendingStages(
      pipeline([stage()]),
      source([{ id: "deploy", intent: "Run it with -Project X." }]),
    );
    expect(result.pipeline.stages[0].subtasks[0].prompt).toBe("Run it with -Project X.");
  });

  it("leaves a subtask prompt alone when it was not the raw intent", () => {
    // A split stage's prompts were written by an agent, not copied from the intent.
    const split = stage({
      subtasks: [
        { id: "deploy-1", title: "Part one", prompt: "Do part one.", status: "pending" },
      ],
    });
    const result = refreshPendingStages(
      pipeline([split]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.pipeline.stages[0].subtasks[0].prompt).toBe("Do part one.");
  });

  it("does not touch a stage that has already passed", () => {
    // History has to stay truthful: a stage kept the instruction it actually ran.
    const passed = stage({ status: "passed" });
    const result = refreshPendingStages(
      pipeline([passed]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.changed).toEqual([]);
    expect(result.pipeline.stages[0].intent).toBe("Run the deployment.");
  });

  it("does not touch a stage whose subtask is already running", () => {
    const running = stage({
      subtasks: [
        { id: "deploy-1", title: "Deploy", prompt: "Run the deployment.", status: "active" },
      ],
    });
    const result = refreshPendingStages(
      pipeline([running]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.changed).toEqual([]);
  });

  it("keeps what it has when the stage is no longer in config", () => {
    const result = refreshPendingStages(
      pipeline([stage({ id: "retired" })]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.changed).toEqual([]);
    expect(result.pipeline.stages[0].intent).toBe("Run the deployment.");
  });

  it("returns the same pipeline object when nothing differs, so no save is needed", () => {
    const original = pipeline([stage()]);
    const result = refreshPendingStages(
      original,
      source([{ id: "deploy", intent: "Run the deployment." }]),
    );
    expect(result.pipeline).toBe(original);
    expect(result.changed).toEqual([]);
  });

  it("refreshes a rule-added stage from the rules, not the route", () => {
    const rule = {
      id: "r1",
      description: "",
      when: { pathPatterns: ["**/*.sql"] },
      stage: { id: "r-review", label: "r", kind: "review", intent: "New rule intent." },
    } as ReviewRule;
    const result = refreshPendingStages(
      pipeline([stage({ id: "r-review", addedByRule: "r1", intent: "Old." })]),
      source([], [rule]),
    );
    expect(result.pipeline.stages[0].intent).toBe("New rule intent.");
  });

  it("leaves splittable alone, because it decides the stage's shape", () => {
    // Flipping it would reshape the pipeline rather than correct an instruction,
    // and the synthesized subtask a non-splittable stage carries would be wrong.
    const result = refreshPendingStages(
      pipeline([stage({ splittable: false })]),
      {
        routes: [
          {
            ...route([{ id: "deploy", intent: "Run the deployment." }]),
            stages: [
              {
                id: "deploy",
                label: "deploy",
                kind: "implement",
                intent: "Run the deployment.",
                splittable: true,
                gate: "approval",
              },
            ],
          } as RouteDefinition,
        ],
        rules: [],
      },
    );
    expect(result.changed).toEqual([]);
    expect(result.pipeline.stages[0].splittable).toBe(false);
  });

  it("picks up a model change too", () => {
    const result = refreshPendingStages(
      pipeline([stage({ model: "opus" })]),
      source([{ id: "deploy", intent: "Run the deployment.", model: "sonnet" }]),
    );
    expect(result.pipeline.stages[0].model).toBe("sonnet");
  });
});

describe("revertToStage", () => {
  const ran = (id: string, status: TaskStage["status"] = "passed") =>
    stage({
      id,
      status,
      finishedAt: "t1",
      checklist: [
        { id: "c1", text: "check it", checked: true, raisedByStage: id },
      ],
      subtasks: [
        {
          id: `${id}-1`,
          title: id,
          prompt: "p",
          status: "done",
          sessionId: "s1",
          finishedAt: "t1",
          reply: "did it",
          activity: { toolCounts: { Bash: 1 } },
        },
      ],
    });

  it("re-opens the named stage and everything after it", () => {
    // Later stages were built on output being discarded, so leaving them passed
    // would mean approving work that no longer exists.
    const result = revertToStage(
      pipeline([ran("plan"), ran("deploy"), ran("verify")]),
      "deploy",
    )!;
    expect(result.reopened).toEqual(["deploy", "verify"]);
    expect(result.pipeline.stages.map((s) => s.status)).toEqual([
      "passed",
      "pending",
      "pending",
    ]);
  });

  it("clears the discarded run's output rather than showing stale results", () => {
    const result = revertToStage(pipeline([ran("deploy")]), "deploy")!;
    const subtask = result.pipeline.stages[0].subtasks[0];
    expect(subtask.status).toBe("pending");
    expect(subtask.reply).toBeUndefined();
    expect(subtask.activity).toBeUndefined();
    expect(subtask.sessionId).toBeUndefined();
  });

  it("drops checklist items raised by the discarded run", () => {
    // They gate the task on evidence about work that no longer exists.
    const result = revertToStage(pipeline([ran("deploy")]), "deploy")!;
    expect(result.pipeline.stages[0].checklist).toBeUndefined();
  });

  it("keeps the operator's guidance, which is usually why they reverted", () => {
    const withGuidance: TaskPipeline = {
      ...pipeline([ran("deploy")]),
      guidance: [
        { id: "g1", stageId: "plan", stageName: "Plan", text: "use -Project X", at: "t" },
      ],
    };
    const result = revertToStage(withGuidance, "deploy")!;
    expect(result.pipeline.guidance).toHaveLength(1);
  });

  it("clears a pending question or refusal from the discarded run", () => {
    const withPending: TaskPipeline = {
      ...pipeline([ran("deploy")]),
      pendingQuestion: {
        stageId: "deploy",
        stageName: "Deploy",
        subtaskId: "deploy-1",
        askedAt: "t",
        items: [{ id: "q1", text: "which?" }],
      },
    };
    const result = revertToStage(withPending, "deploy")!;
    expect(result.pipeline.pendingQuestion).toBeUndefined();
  });

  it("returns undefined for a stage that is not in the pipeline", () => {
    expect(revertToStage(pipeline([ran("deploy")]), "nope")).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const original = pipeline([ran("deploy")]);
    revertToStage(original, "deploy");
    expect(original.stages[0].status).toBe("passed");
    expect(original.stages[0].subtasks[0].reply).toBe("did it");
  });
});
