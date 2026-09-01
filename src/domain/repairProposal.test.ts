import { describe, expect, it } from "vitest";
import { adjudicateRepair, parseRepairProposals } from "./repairProposal";
import { TaskPipeline, TaskStage } from "./taskPipeline";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "implement",
    name: "Implement the data",
    kind: "implementation",
    status: "passed",
    intent: "Build it.",
    splittable: false,
    requiresApproval: false,
    subtasks: [
      { id: "implement-1", title: "Build", prompt: "p", status: "done", reply: "Built it." },
    ],
    ...overrides,
  };
}

function review(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "review",
    name: "SQL object review",
    kind: "domainReview",
    status: "awaiting-approval",
    intent: "Review it.",
    splittable: false,
    requiresApproval: true,
    sendBackTo: ["kind:implementation"],
    subtasks: [{ id: "review-1", title: "Review", prompt: "p", status: "done" }],
    ...overrides,
  };
}

function pipeline(stages: TaskStage[]): TaskPipeline {
  return {
    routeId: "r",
    routeLabel: "R",
    stages,
    updatedAt: "2026-09-01T00:00:00.000Z",
  } as TaskPipeline;
}

describe("parseRepairProposals", () => {
  it("reads a target and a finding", () => {
    expect(
      parseRepairProposals("REPAIR: Implement the data — purchases are double-counted"),
    ).toEqual([{ target: "Implement the data", finding: "purchases are double-counted" }]);
  });

  it("accepts the separators a model actually writes", () => {
    const replies = [
      "REPAIR: implement - fix it",
      "REPAIR: implement -- fix it",
      "REPAIR: implement – fix it",
      "REPAIR: implement: fix it",
    ];
    for (const reply of replies) {
      expect(parseRepairProposals(reply)).toEqual([{ target: "implement", finding: "fix it" }]);
    }
  });

  // The failure `markerLine` was built from: a reply is markdown, and a stage writing a
  // section of a report heads it. Inherited rather than re-implemented here.
  it("reads a marker behind a heading or a bold run", () => {
    expect(parseRepairProposals("### REPAIR: implement — fix it")).toHaveLength(1);
    expect(parseRepairProposals("**REPAIR: implement — fix it**")).toHaveLength(1);
  });

  it("ignores the word in prose", () => {
    expect(parseRepairProposals("We could REPAIR: this later, perhaps")).toHaveLength(0);
  });

  it("drops a line with no finding after the target", () => {
    expect(parseRepairProposals("REPAIR: implement")).toHaveLength(0);
  });

  it("reads several proposals", () => {
    expect(
      parseRepairProposals("REPAIR: implement — fix A\nsome prose\nREPAIR: plan — fix B"),
    ).toHaveLength(2);
  });
});

describe("adjudicateRepair", () => {
  const target = { target: "Implement the data", finding: "purchases are double-counted" };

  it("admits a target the route already permits", () => {
    const ruling = adjudicateRepair(pipeline([stage(), review()]), "review", target);
    expect(ruling.admissible).toBe(true);
    if (ruling.admissible) expect(ruling.stage.id).toBe("implement");
  });

  it("matches on the stage id as well as its label", () => {
    const ruling = adjudicateRepair(pipeline([stage(), review()]), "review", {
      target: "implement",
      finding: "fix it",
    });
    expect(ruling.admissible).toBe(true);
  });

  // `sendBackTo` is the existing authority and this adds no second one. A review that
  // declares nothing may reach nothing.
  it("refuses a review that declares no send-back targets", () => {
    const ruling = adjudicateRepair(
      pipeline([stage(), review({ sendBackTo: undefined })]),
      "review",
      target,
    );
    expect(ruling.admissible).toBe(false);
  });

  it("refuses a stage outside what sendBackTo permits", () => {
    const ruling = adjudicateRepair(
      pipeline([stage({ id: "plan", name: "Plan", kind: "planning" }), review()]),
      "review",
      { target: "Plan", finding: "wrong layer" },
    );
    expect(ruling.admissible).toBe(false);
    if (!ruling.admissible) expect(ruling.reason).toContain("may not send findings back");
  });

  it("refuses a repair that reaches forward, and says so", () => {
    const ruling = adjudicateRepair(
      // A stage before the review, so this exercises the forward-reach refusal rather
      // than the "nothing precedes it" guard above it.
      pipeline([
        stage(),
        review(),
        stage({ id: "later", name: "Deploy to DEV", kind: "implementation" }),
      ]),
      "review",
      { target: "Deploy to DEV", finding: "fix it" },
    );
    expect(ruling.admissible).toBe(false);
    if (!ruling.admissible) expect(ruling.reason).toContain("cannot reach forward");
  });

  it("refuses a name that matches nothing rather than guessing at one", () => {
    const ruling = adjudicateRepair(pipeline([stage(), review()]), "review", {
      target: "Implement the dat",
      finding: "fix it",
    });
    expect(ruling.admissible).toBe(false);
    if (!ruling.admissible) expect(ruling.reason).toContain("no stage before this review");
  });

  // The NMGB-2814 failure, as a refusal: a correction is handed the stage's own previous
  // output, and a stage that produced none gives it nothing to start from.
  it("refuses a target that produced nothing", () => {
    const empty = stage({ subtasks: [{ id: "s1", title: "t", prompt: "p", status: "pending" }] });
    const ruling = adjudicateRepair(pipeline([empty, review()]), "review", target);
    expect(ruling.admissible).toBe(false);
    if (!ruling.admissible) expect(ruling.reason).toContain("produced nothing");
  });

  it("counts written files as output for a stage whose reply was cleared", () => {
    const written = stage({
      subtasks: [
        {
          id: "s1",
          title: "t",
          prompt: "p",
          status: "done",
          activity: { pathsWritten: ["a.sql"] },
        },
      ],
    });
    expect(adjudicateRepair(pipeline([written, review()]), "review", target).admissible).toBe(true);
  });
});
