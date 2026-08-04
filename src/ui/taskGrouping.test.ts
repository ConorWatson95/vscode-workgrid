import { describe, expect, it } from "vitest";
import { groupForTask, groupTasks, GROUP_ORDER } from "./taskGrouping";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";

const stage = (over: Partial<TaskStage> = {}): TaskStage =>
  ({
    id: "s1",
    name: "S1",
    kind: "implementation",
    status: "pending",
    intent: "",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...over,
  }) as TaskStage;

const pipeline = (stages: TaskStage[], over: Partial<TaskPipeline> = {}): TaskPipeline =>
  ({ routeId: "sql-change", stages, ...over }) as TaskPipeline;

const of = (pipe?: TaskPipeline, heldCalls = 0, status = "active") =>
  groupForTask({ status, pipeline: pipe, heldCalls });

describe("groupForTask", () => {
  it("files a task with no route separately", () => {
    expect(of(undefined)).toBe("no-route");
    expect(of(pipeline([]))).toBe("no-route");
  });

  it("files an archived task by its status, whatever its route says", () => {
    expect(of(pipeline([stage({ status: "active" })]), 0, "archived")).toBe("archived");
  });

  it("needs you when a tool call is held", () => {
    // The most urgent thing the list can show: a CLI stopped mid-turn.
    expect(of(pipeline([stage({ status: "active" })]), 1)).toBe("needs-you");
  });

  it("needs you for an unanswered question", () => {
    const p = pipeline([stage({ status: "active" })], {
      pendingQuestion: { stageId: "s1", stageName: "S1", subtaskId: "s1-1", items: [{ id: "q1", question: "Which?" }] },
    } as Partial<TaskPipeline>);
    expect(of(p)).toBe("needs-you");
  });

  it("does not need you for a question already answered", () => {
    const p = pipeline([stage({ status: "active" })], {
      pendingQuestion: {
        stageId: "s1",
        stageName: "S1",
        subtaskId: "s1-1",
        items: [{ id: "q1", question: "Which?", answer: "DEV" }],
      },
    } as Partial<TaskPipeline>);
    expect(of(p)).toBe("working");
  });

  it("needs you for a refusal not yet granted", () => {
    const p = pipeline([stage({ status: "active" })], {
      pendingDenials: {
        stageId: "s1",
        stageName: "S1",
        subtaskId: "s1-1",
        refusedAt: "t",
        items: [{ tool: "Bash", reason: "denied" }],
      },
    } as Partial<TaskPipeline>);
    expect(of(p)).toBe("needs-you");
  });

  it("needs you at an approval gate", () => {
    expect(of(pipeline([stage({ status: "awaiting-approval" })]))).toBe("needs-you");
  });

  it("needs you when a stage failed, since it cannot resolve itself", () => {
    expect(of(pipeline([stage({ status: "failed" })]))).toBe("needs-you");
  });

  it("needs you at a verification gate, outstanding items or not", () => {
    const withItems = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "check", checked: false }] }),
      stage({ id: "b", kind: "humanVerification", status: "pending" }),
    ]);
    expect(of(withItems)).toBe("needs-you");
    const ticked = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "check", checked: true }] }),
      stage({ id: "b", kind: "humanVerification", status: "pending" }),
    ]);
    expect(of(ticked)).toBe("needs-you");
  });

  it("does not treat items raised mid-route as needing you yet", () => {
    // They are real but not blocking, and counting them would put nearly every
    // harnessed task in this group — the sifting problem again.
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "check", checked: false }] }),
      stage({ id: "b", status: "active" }),
      stage({ id: "c", kind: "humanVerification", status: "pending" }),
    ]);
    expect(of(p)).toBe("working");
  });

  it("is working when a stage is running and nothing is blocked", () => {
    expect(of(pipeline([stage({ status: "active" })]))).toBe("working");
  });

  it("is parked when nothing runs and nothing waits on you", () => {
    expect(of(pipeline([stage({ id: "a", status: "passed" }), stage({ id: "b", status: "pending" })]))).toBe(
      "parked",
    );
  });

  it("is done when every stage resolved", () => {
    expect(
      of(pipeline([stage({ id: "a", status: "passed" }), stage({ id: "b", status: "skipped" })])),
    ).toBe("done");
  });
});

describe("groupTasks", () => {
  it("orders groups worst-first and drops empty ones", () => {
    const grouped = groupTasks(["a", "b", "c"], (item) =>
      item === "a" ? "parked" : item === "b" ? "needs-you" : "parked",
    );
    expect(grouped.map((g) => g.id)).toEqual(["needs-you", "parked"]);
    expect(grouped[1].items).toEqual(["a", "c"]);
  });

  it("returns one group when everything lands together", () => {
    // The caller flattens this case: one wrapper around one list hides tasks
    // without organising anything.
    expect(groupTasks(["a", "b"], () => "working")).toHaveLength(1);
  });

  it("labels every group it can produce", () => {
    for (const id of GROUP_ORDER) {
      expect(groupTasks(["x"], () => id)[0].label.length).toBeGreaterThan(0);
    }
  });
});
