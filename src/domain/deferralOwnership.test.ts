import { describe, expect, it } from "vitest";
import { ownedByPendingStage } from "./deferralOwnership";
import { TaskPipeline, TaskStage } from "./taskPipeline";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "preview",
    name: "Preview the DEV deployment",
    kind: "test",
    status: "pending",
    intent: "Preview it.",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...overrides,
  };
}

const pipeline = (stages: TaskStage[]): TaskPipeline =>
  ({ routeId: "r", routeLabel: "R", stages }) as TaskPipeline;

const ROUTE = pipeline([
  stage({ id: "preview", name: "Preview the DEV deployment" }),
  stage({ id: "deploy-dev", name: "Deploy to DEV" }),
  stage({ id: "implement", name: "Implement" }),
]);

describe("work a stage declined that its own route already owns", () => {
  it("finds the stage a real decline named", () => {
    // Verbatim from the run that prompted this, minus the item's own preamble.
    const owner = ownedByPendingStage(
      'actually deploying these 3 files to DEV — "Deploy to DEV" stage.',
      ROUTE,
      "preview",
    );
    expect(owner?.id).toBe("deploy-dev");
  });

  it("reads an unquoted mention beside the word stage", () => {
    expect(
      ownedByPendingStage("the Deploy to DEV stage does it", ROUTE, "preview")?.id,
    ).toBe("deploy-dev");
  });

  it("reads a quoted mention with no the word stage at all", () => {
    expect(
      ownedByPendingStage('this belongs to "Deploy to DEV"', ROUTE, "preview")?.id,
    ).toBe("deploy-dev");
  });

  it("ignores a stage name that merely appears in the prose", () => {
    // The failure that matters: auto-settling a real ownerless item is how a live
    // publish halted on a data structure nobody had created. A bare mention is not a
    // handover, and "Implement" is exactly the kind of name that turns up by accident.
    expect(
      ownedByPendingStage(
        "implement the staging table nobody has created",
        ROUTE,
        "preview",
      ),
    ).toBeUndefined();
  });

  it("ignores a stage that has already run", () => {
    // Naming a stage that is finished is not a handover, it is an observation that
    // something was missed — which is a real deferral.
    const done = pipeline([
      stage({ id: "preview", name: "Preview the DEV deployment" }),
      stage({ id: "deploy-dev", name: "Deploy to DEV", status: "passed" }),
    ]);
    expect(
      ownedByPendingStage('the "Deploy to DEV" stage should have done this', done, "preview"),
    ).toBeUndefined();
  });

  it("ignores the raising stage naming itself", () => {
    // That is a refusal, not a handover, and BLOCKED is the marker for it.
    expect(
      ownedByPendingStage(
        'the "Preview the DEV deployment" stage did not do this',
        ROUTE,
        "preview",
      ),
    ).toBeUndefined();
  });

  it("finds nothing in an item that names no stage", () => {
    expect(
      ownedByPendingStage("a matching staging table needs creating", ROUTE, "preview"),
    ).toBeUndefined();
  });

  it("is case-insensitive, since a stage rewords the name it was given", () => {
    expect(
      ownedByPendingStage("owned by the deploy to dev stage", ROUTE, "preview")?.id,
    ).toBe("deploy-dev");
  });
});
