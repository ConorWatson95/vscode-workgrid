import { describe, it, expect } from "vitest";
import {
  checklistPresentation,
  pipelineSummary,
  stagePresentation,
  stageExpansion,
  stageBlock,
  activeStageLabel,
} from "./stagePresentation";
import { ChecklistItem, TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { createPipeline, planStage, recordChecklist } from "../domain/pipelineEngine";
import { findRoute } from "../domain/taskRoute";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "fix",
    name: "Fix",
    kind: "implementation",
    status: "pending",
    intent: "Fix it.",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...overrides,
  };
}

function subtask(id: string, status: TaskStage["subtasks"][number]["status"]) {
  return { id, title: id, prompt: "p", status };
}

function item(id: string, checked: boolean): ChecklistItem {
  return { id, text: `check ${id}`, checked, raisedByStage: "fix" };
}

describe("stagePresentation", () => {
  it("distinguishes every stage status by icon", () => {
    const icons = (["pending", "active", "awaiting-approval", "passed", "failed", "skipped"] as const).map(
      (status) => stagePresentation(stage({ status })).iconId,
    );
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("spins only while a stage is active", () => {
    expect(stagePresentation(stage({ status: "active" })).iconId).toContain("~spin");
    expect(stagePresentation(stage({ status: "pending" })).iconId).not.toContain("~spin");
  });

  it("flags a splittable stage that has not been planned yet", () => {
    const visual = stagePresentation(stage({ splittable: true, subtasks: [] }));
    expect(visual.description).toBe("needs planning");
    expect(visual.iconId).toBe("list-tree");
  });

  it("counts subtask progress once there is more than one", () => {
    const visual = stagePresentation(
      stage({
        status: "active",
        subtasks: [subtask("a", "done"), subtask("b", "active"), subtask("c", "pending")],
      }),
    );
    expect(visual.description).toBe("1/3");
  });

  it("omits a count for a single-unit stage, where 0/1 is noise", () => {
    expect(stagePresentation(stage({ subtasks: [subtask("a", "pending")] })).description).toBe("");
  });

  it("surfaces outstanding verification items", () => {
    const visual = stagePresentation(
      stage({ status: "awaiting-approval", checklist: [item("c1", false), item("c2", true)] }),
    );
    expect(visual.description).toContain("awaiting approval");
    // "for you" because the items are the reader's job, not work the agent left
    // undone — a behaviour-review stage is a planner, by its own prompt.
    expect(visual.description).toContain("1 for you to verify");
  });

  it("still reports outstanding items on a stage that has passed", () => {
    // The bug this fixes: a behaviour-review stage passes as soon as it has
    // *written* the checklist, because planning was its whole job. With an empty
    // description it then said nothing about the items it had just raised, so they
    // were invisible on a green row.
    const visual = stagePresentation(
      stage({ status: "passed", checklist: [item("c1", false), item("c2", false)] }),
    );
    expect(visual.description).toContain("2 for you to verify");
  });

  it("says nothing extra on a passed stage with nothing outstanding", () => {
    const visual = stagePresentation(stage({ status: "passed" }));
    expect(visual.description).toBe("");
  });

  it("shows the pipeline total on the gate, not its own empty checklist", () => {
    // A human-verification stage raises no items itself but is blocked by all of
    // them, so reading only its own checklist left it refusing to pass while
    // displaying no reason.
    const gate = stage({
      status: "awaiting-approval",
      kind: "humanVerification",
      checklist: undefined,
    });
    expect(stagePresentation(gate, 3).description).toContain("3 for you to verify");
  });

  it("leaves a non-gate stage reporting its own items", () => {
    const review = stage({
      status: "awaiting-approval",
      checklist: [item("c1", false)],
    });
    expect(stagePresentation(review, 9).description).toContain("1 for you to verify");
  });

  it("shows the failure reason rather than just 'failed'", () => {
    const visual = stagePresentation(
      stage({
        status: "failed",
        subtasks: [{ ...subtask("a", "failed"), failureReason: "suite red" }],
      }),
    );
    expect(visual.description).toBe("suite red");
  });

  it("falls back to 'failed' when no reason was recorded", () => {
    expect(
      stagePresentation(stage({ status: "failed", subtasks: [subtask("a", "failed")] })).description,
    ).toBe("failed");
  });

  it("says nothing extra for a passed stage", () => {
    expect(stagePresentation(stage({ status: "passed" })).description).toBe("");
  });

  it("gives each status a distinct context value for menu targeting", () => {
    expect(stagePresentation(stage({ status: "awaiting-approval" })).contextValue).toBe(
      "stage-awaiting-approval",
    );
    expect(stagePresentation(stage({ status: "failed" })).contextValue).toBe("stage-failed");
  });

  it("reads a stage holding a failed subtask as failed, not as working", () => {
    // The shape a failed stage actually has: the engine fails a *stage* only once
    // every subtask resolves, and the driver stops at the first failure. So the row
    // spun in blue on a route that had stopped, with the reason nowhere on it — and
    // `stage-active` is not what Retry This Stage is keyed on, so the one command that
    // could move it was not offered.
    const visual = stagePresentation(
      stage({
        status: "active",
        subtasks: [
          {
            id: "s1",
            title: "One",
            prompt: "",
            status: "failed",
            failureReason: "session failed — the CLI exited with code 1",
          },
          { id: "s2", title: "Two", prompt: "", status: "pending" },
        ],
      }),
    );
    expect(visual.iconId).toBe("error");
    expect(visual.contextValue).toContain("stage-failed");
    expect(visual.description).toContain("exited with code 1");
  });

  it("still spins while a subtask is genuinely in flight", () => {
    const visual = stagePresentation(
      stage({
        status: "active",
        subtasks: [{ id: "s1", title: "One", prompt: "", status: "active" }],
      }),
    );
    expect(visual.iconId).toBe("loading~spin");
  });

  it("marks a stage with output as correctable, whatever its status", () => {
    const ran = { ...subtask("a", "done"), reply: "did it" };
    for (const status of ["passed", "failed", "awaiting-approval", "pending"] as const) {
      expect(stagePresentation(stage({ status, subtasks: [ran] })).contextValue).toContain(
        "correctable",
      );
    }
  });

  // The bug this pins: a correction sets its stage back to `pending`, and the menu
  // keyed on `passed|failed|awaiting-approval` — so filing one correction hid the
  // command that files the next, which is exactly the batching the dialog invites.
  it("keeps a corrected stage correctable once it is pending again", () => {
    const corrected = stage({
      status: "pending",
      subtasks: [
        { ...subtask("a", "done"), reply: "did it" },
        { ...subtask("fix-1", "pending"), correction: { finding: "wrong", at: "t" } },
      ],
    });
    expect(stagePresentation(corrected).contextValue).toBe(
      "stage-pending correctable has-correction",
    );
  });

  // Separate from `correctable`, and not implied by it: a stage can have output worth
  // correcting without ever having been corrected, and only the latter can be withdrawn.
  it("marks a corrected stage as having a correction to withdraw", () => {
    const uncorrected = stage({
      status: "passed",
      subtasks: [{ ...subtask("a", "done"), reply: "did it" }],
    });
    expect(stagePresentation(uncorrected).contextValue).not.toContain("has-correction");
  });

  // A correction mid-flight has nothing to withdraw yet — stopping the task comes first.
  it("does not offer a withdrawal while the correction is running", () => {
    const running = stage({
      status: "active",
      subtasks: [
        { ...subtask("a", "done"), reply: "did it" },
        { ...subtask("fix-1", "active"), correction: { finding: "wrong", at: "t" } },
      ],
    });
    expect(stagePresentation(running).contextValue).not.toContain("has-correction");
  });

  it("leaves a stage that has produced nothing uncorrectable", () => {
    expect(stagePresentation(stage({ status: "pending" })).contextValue).toBe("stage-pending");
    expect(
      stagePresentation(stage({ status: "active", subtasks: [subtask("a", "running")] }))
        .contextValue,
    ).toBe("stage-active");
  });
});

describe("checklistPresentation", () => {
  it("marks checked and unchecked items differently", () => {
    expect(checklistPresentation(item("a", true)).contextValue).toBe("checklist-checked");
    expect(checklistPresentation(item("a", false)).contextValue).toBe("checklist-unchecked");
    expect(checklistPresentation(item("a", true)).iconId).not.toBe(
      checklistPresentation(item("a", false)).iconId,
    );
  });
});

describe("pipelineSummary", () => {
  it("returns nothing for an unharnessed task", () => {
    expect(pipelineSummary(undefined)).toBeUndefined();
    expect(pipelineSummary({ routeId: "x", stages: [] })).toBeUndefined();
  });

  it("summarises route, stage progress and outstanding verification", () => {
    const route = findRoute("bug-fix")!;
    let pipeline = createPipeline(route);
    pipeline = { ...pipeline, stages: pipeline.stages.map((s, i) => (i === 0 ? { ...s, status: "passed" } : s)) };
    const planned = planStage(pipeline, "fix", [{ title: "a", prompt: "a" }]);
    if (planned.ok) pipeline = planned.value;
    const withItems = recordChecklist(pipeline, "code-review", ["one", "two"]);
    if (withItems.ok) pipeline = withItems.value;

    const summary = pipelineSummary(pipeline, route.label);
    expect(summary).toBe("Bug fix · 1/5 · 2 to verify");
  });

  it("falls back to the route id when no label is supplied", () => {
    expect(pipelineSummary({ routeId: "ad-hoc", stages: [stage()] })).toBe("ad-hoc · 0/1");
  });

  it("ignores items belonging to a skipped stage", () => {
    const summary = pipelineSummary({
      routeId: "r",
      stages: [stage({ status: "skipped", checklist: [item("c1", false)] })],
    });
    expect(summary).toBe("r · 1/1");
  });
});

describe("stageExpansion", () => {
  const stage = (overrides: Partial<TaskStage> = {}): TaskStage =>
    ({
      id: "s1",
      name: "Build",
      kind: "implement",
      intent: "do the work",
      status: "running",
      subtasks: [],
      ...overrides,
    }) as TaskStage;

  const pipeline = (overrides: Partial<TaskPipeline> = {}): TaskPipeline =>
    ({ stages: [], ...overrides }) as TaskPipeline;

  it("is a leaf when nothing is nested", () => {
    expect(stageExpansion(pipeline(), stage()).childCount).toBe(0);
  });

  it("counts a checklist", () => {
    const s = stage({ checklist: [{ id: "c1", text: "check", checked: false }] });
    expect(stageExpansion(pipeline(), s)).toEqual({
      childCount: 1,
      needsAttention: true,
    });
  });

  it("counts refusals, so a stage with only refusals is not a leaf", () => {
    // Regression: this shape shipped as a leaf, making the rows that grant a
    // refusal unreachable.
    const p = pipeline({
      pendingDenials: {
        stageId: "s1",
        stageName: "Build",
        subtaskId: "st1",
        refusedAt: "2026-08-04T00:00:00.000Z",
        items: [
          { id: "d1", tool: "Bash", reason: "no", attempts: 1, granted: false },
        ],
      },
    } as Partial<TaskPipeline>);
    expect(stageExpansion(p, stage())).toEqual({
      childCount: 1,
      needsAttention: true,
    });
  });

  it("counts questions, so a stage with only questions is not a leaf", () => {
    // The same regression, one release later, for questions.
    const p = pipeline({
      pendingQuestion: {
        stageId: "s1",
        stageName: "Build",
        subtaskId: "st1",
        askedAt: "2026-08-04T00:00:00.000Z",
        items: [{ id: "q1", text: "Which environment?" }],
      },
    } as Partial<TaskPipeline>);
    expect(stageExpansion(p, stage())).toEqual({
      childCount: 1,
      needsAttention: true,
    });
  });

  it("ignores questions and refusals belonging to another stage", () => {
    const p = pipeline({
      pendingQuestion: {
        stageId: "other",
        stageName: "Other",
        subtaskId: "st1",
        askedAt: "2026-08-04T00:00:00.000Z",
        items: [{ id: "q1", text: "?" }],
      },
    } as Partial<TaskPipeline>);
    expect(stageExpansion(p, stage()).childCount).toBe(0);
  });

  it("stops needing attention once everything is resolved", () => {
    const s = stage({ checklist: [{ id: "c1", text: "check", checked: true }] });
    const p = pipeline({
      pendingQuestion: {
        stageId: "s1",
        stageName: "Build",
        subtaskId: "st1",
        askedAt: "2026-08-04T00:00:00.000Z",
        items: [{ id: "q1", text: "?", answer: "yes" }],
      },
    } as Partial<TaskPipeline>);
    expect(stageExpansion(p, s)).toEqual({ childCount: 2, needsAttention: false });
  });

  it("treats a blank answer as unanswered", () => {
    const p = pipeline({
      pendingQuestion: {
        stageId: "s1",
        stageName: "Build",
        subtaskId: "st1",
        askedAt: "2026-08-04T00:00:00.000Z",
        items: [{ id: "q1", text: "?", answer: "   " }],
      },
    } as Partial<TaskPipeline>);
    expect(stageExpansion(p, stage()).needsAttention).toBe(true);
  });
});

describe("stageBlock and activeStageLabel", () => {
  const s = (overrides: Partial<TaskStage> = {}): TaskStage =>
    ({
      id: "s1",
      name: "Plan",
      kind: "plan",
      intent: "plan it",
      status: "active",
      subtasks: [],
      ...overrides,
    }) as TaskStage;

  const withQuestions = (items: unknown[], stageId = "s1") =>
    ({
      stages: [s()],
      pendingQuestion: {
        stageId,
        stageName: "Plan",
        subtaskId: "st1",
        askedAt: "2026-08-04T00:00:00.000Z",
        items,
      },
    }) as unknown as TaskPipeline;

  const withRefusals = (items: unknown[], stageId = "s1") =>
    ({
      stages: [s()],
      pendingDenials: {
        stageId,
        stageName: "Plan",
        subtaskId: "st1",
        refusedAt: "2026-08-04T00:00:00.000Z",
        items,
      },
    }) as unknown as TaskPipeline;

  it("reports nothing when the stage is genuinely working", () => {
    expect(stageBlock({ stages: [s()] } as TaskPipeline, s())).toBeUndefined();
  });

  it("reports unanswered questions", () => {
    const p = withQuestions([{ id: "q1", text: "?" }, { id: "q2", text: "?", answer: "yes" }]);
    expect(stageBlock(p, s())).toEqual({ kind: "questions", count: 1 });
  });

  it("reports ungranted refusals", () => {
    const p = withRefusals([
      { id: "d1", tool: "Bash", reason: "no", attempts: 1, granted: false },
      { id: "d2", tool: "Bash", reason: "no", attempts: 1, granted: true },
    ]);
    expect(stageBlock(p, s())).toEqual({ kind: "refusals", count: 1 });
  });

  it("ignores blocks belonging to another stage", () => {
    expect(stageBlock(withQuestions([{ id: "q1", text: "?" }], "other"), s())).toBeUndefined();
  });

  it("clears once everything is resolved", () => {
    const p = withQuestions([{ id: "q1", text: "?", answer: "done" }]);
    expect(stageBlock(p, s())).toBeUndefined();
  });

  it("names the running stage rather than guessing from git", () => {
    // The bug: a task whose planning stage was still running said "implementing",
    // because the phase came from dirty files and commits.
    expect(activeStageLabel({ stages: [s()] } as TaskPipeline)).toBe("Plan…");
  });

  it("says what a blocked stage is waiting for", () => {
    const p = withQuestions([{ id: "q1", text: "?" }, { id: "q2", text: "?" }]);
    expect(activeStageLabel(p)).toBe("Plan — waiting — 2 questions");
  });

  it("uses the singular for one outstanding item", () => {
    const p = withQuestions([{ id: "q1", text: "?" }]);
    expect(activeStageLabel(p)).toBe("Plan — waiting — 1 question");
  });

  it("reports a stage awaiting approval as such", () => {
    const p = { stages: [s({ status: "awaiting-approval" })] } as TaskPipeline;
    expect(activeStageLabel(p)).toBe("Plan — awaiting approval");
  });

  it("prefers an active stage over one awaiting approval", () => {
    const p = {
      stages: [s({ id: "a", name: "Gate", status: "awaiting-approval" }), s({ id: "b", name: "Build" })],
    } as TaskPipeline;
    expect(activeStageLabel(p)).toBe("Build…");
  });

  it("leaves the git-derived phase alone when no stage is in play", () => {
    expect(activeStageLabel(undefined)).toBeUndefined();
    expect(
      activeStageLabel({ stages: [s({ status: "passed" })] } as TaskPipeline),
    ).toBeUndefined();
  });
});
