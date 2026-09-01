import { describe, expect, it } from "vitest";
import {
  adjudicateInsert,
  adjudicateReverify,
  parseInsertProposals,
  parseReverifyProposals,
} from "./routeMutation";
import { TaskPipeline, TaskStage } from "./taskPipeline";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "preview",
    name: "Preview the DEV deployment",
    kind: "test",
    status: "passed",
    intent: "Preview it.",
    splittable: false,
    requiresApproval: false,
    subtasks: [{ id: "preview-1", title: "Preview", prompt: "p", status: "done" }],
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

const review = stage({
  id: "review",
  name: "SQL object review",
  kind: "domainReview",
  status: "active",
});

describe("parseReverifyProposals", () => {
  // The exact shape the live corpus raised eleven times as a deferral.
  it("reads the staleness case that had nowhere to go", () => {
    expect(
      parseReverifyProposals(
        "REVERIFY: Preview the DEV deployment — ec-preview.md predates the current deploy/001",
      ),
    ).toEqual([
      {
        target: "Preview the DEV deployment",
        reason: "ec-preview.md predates the current deploy/001",
      },
    ]);
  });

  it("reads a marker behind a heading", () => {
    expect(parseReverifyProposals("## REVERIFY: preview — it is stale")).toHaveLength(1);
  });

  it("ignores the word in prose", () => {
    expect(parseReverifyProposals("we should reverify: probably")).toHaveLength(0);
  });

  it("drops a line that names no reason", () => {
    expect(parseReverifyProposals("REVERIFY: preview")).toHaveLength(0);
  });
});

describe("adjudicateReverify", () => {
  const proposal = { target: "Preview the DEV deployment", reason: "the scripts changed" };

  it("admits a settled earlier stage", () => {
    const ruling = adjudicateReverify(pipeline([stage(), review]), "review", proposal);
    expect(ruling.admissible).toBe(true);
    if (ruling.admissible) expect(ruling.stage.id).toBe("preview");
  });

  // Unlike a repair, this needs no `sendBackTo`: a repair says someone was wrong and
  // the route decides who may say that, while this says a file went stale.
  it("needs no send-back declaration", () => {
    expect(review.sendBackTo).toBeUndefined();
    expect(adjudicateReverify(pipeline([stage(), review]), "review", proposal).admissible).toBe(
      true,
    );
  });

  it("refuses a stage that has not run, which would read the current state anyway", () => {
    const ruling = adjudicateReverify(
      pipeline([stage({ status: "pending" }), review]),
      "review",
      proposal,
    );
    expect(ruling.admissible).toBe(false);
    if (!ruling.admissible) expect(ruling.reason).toContain("current state anyway");
  });

  it("refuses a name matching nothing rather than guessing", () => {
    const ruling = adjudicateReverify(pipeline([stage(), review]), "review", {
      target: "Preview the DEV deploy",
      reason: "stale",
    });
    expect(ruling.admissible).toBe(false);
  });

  it("refuses a stage after this one", () => {
    const ruling = adjudicateReverify(
      pipeline([stage({ id: "a", name: "A" }), review, stage({ id: "later", name: "Later" })]),
      "review",
      { target: "Later", reason: "stale" },
    );
    expect(ruling.admissible).toBe(false);
  });
});

describe("parseInsertProposals", () => {
  it("reads kind, name and objective", () => {
    expect(
      parseInsertProposals("INSERT-STAGE: implementation | Document the loader | Write it up"),
    ).toEqual([{ kind: "implementation", name: "Document the loader", intent: "Write it up" }]);
  });

  // A gate is how a human's authority enters a route, and a stage proposing one is a
  // stage deciding when it needs supervising.
  it("refuses to let a stage propose a human gate or an assessment", () => {
    expect(parseInsertProposals("INSERT-STAGE: humanVerification | Check | Look")).toHaveLength(0);
    expect(parseInsertProposals("INSERT-STAGE: assessment | Assess | Look")).toHaveLength(0);
  });

  it("drops an unrecognised kind rather than defaulting one", () => {
    expect(parseInsertProposals("INSERT-STAGE: cleanup | Tidy | Do it")).toHaveLength(0);
  });

  it("drops a line missing a field", () => {
    expect(parseInsertProposals("INSERT-STAGE: implementation | Only a name")).toHaveLength(0);
  });
});

describe("adjudicateInsert", () => {
  const at = (stages: readonly TaskStage[]) => stages.length;
  const proposal = {
    kind: "implementation" as const,
    name: "Document the loader",
    intent: "Write up the pipeline",
  };

  it("creates a stage carrying the provenance of the one that asked for it", () => {
    const ruling = adjudicateInsert(pipeline([stage(), review]), "review", proposal, at);
    expect(ruling.admissible).toBe(true);
    if (!ruling.admissible) return;
    expect(ruling.stage.insertedBecause).toMatchObject({
      stageId: "review",
      stageName: "SQL object review",
    });
    expect(ruling.stage.intent).toBe("Write up the pipeline");
  });

  // Nobody declared this stage, so nobody has said it may pass unlooked-at.
  it("always gates an inserted stage", () => {
    const ruling = adjudicateInsert(pipeline([stage(), review]), "review", proposal, at);
    if (!ruling.admissible) throw new Error("expected admissible");
    expect(ruling.stage.requiresApproval).toBe(true);
    expect(ruling.stage.authority).toBeUndefined();
  });

  it("refuses work the route already has a stage for", () => {
    const ruling = adjudicateInsert(pipeline([stage(), review]), "review", {
      ...proposal,
      name: "preview the dev deployment",
    }, at);
    expect(ruling.admissible).toBe(false);
    if (!ruling.admissible) expect(ruling.reason).toContain("already has a stage");
  });

  it("gives each inserted stage its own id", () => {
    const first = adjudicateInsert(pipeline([stage(), review]), "review", proposal, at);
    if (!first.admissible) throw new Error("expected admissible");
    const next = adjudicateInsert(
      pipeline([stage(), review, first.stage]),
      "review",
      { ...proposal, name: "Another" },
      at,
    );
    if (!next.admissible) throw new Error("expected admissible");
    expect(next.stage.id).not.toBe(first.stage.id);
  });

  it("refuses a proposal with no objective", () => {
    const ruling = adjudicateInsert(
      pipeline([stage(), review]),
      "review",
      { ...proposal, intent: "  " },
      at,
    );
    expect(ruling.admissible).toBe(false);
  });
});
