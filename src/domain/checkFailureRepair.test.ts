import { describe, expect, it } from "vitest";
import {
  declaredRepair,
  formatCheckFailureNote,
  isDeclaredRepair,
} from "./checkFailureRepair";
import { TaskPipeline, TaskStage } from "./taskPipeline";

const OUTPUT =
  "Verification failed (exit 2): Test-WorkPromoted.ps1 -TargetBranch UAT\n" +
  "1 of 7 commit(s) for NMGB-2533 are not on origin/UAT: d267029";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "promote",
    name: "Promote to UAT",
    kind: "deployment",
    status: "passed",
    intent: "Promote.",
    splittable: false,
    requiresApproval: false,
    subtasks: [
      { id: "promote-1", title: "Promote", prompt: "Promote.", status: "done", reply: "done" },
    ],
    ...overrides,
  } as TaskStage;
}

/** A promote stage that produced something, then a gate whose check failed on it. */
function pipelineWith(overrides: Partial<TaskStage> = {}): TaskPipeline {
  return {
    routeId: "existing-change",
    stages: [
      stage(),
      stage({
        id: "acceptance",
        name: "UAT acceptance",
        kind: "humanVerification",
        status: "failed",
        onFailure: { repair: "promote" },
        subtasks: [
          {
            id: "acceptance-1",
            title: "Accept",
            prompt: "Accept.",
            status: "failed",
            failureReason: OUTPUT,
          },
        ],
        ...overrides,
      }),
    ],
  };
}

describe("declaredRepair", () => {
  it("names the stage the route says owes the fix", () => {
    const found = declaredRepair(pipelineWith(), "acceptance");
    expect(isDeclaredRepair(found)).toBe(true);
    if (!isDeclaredRepair(found)) return;
    expect(found.owner.id).toBe("promote");
    expect(found.failed.id).toBe("acceptance");
  });

  it("carries the check's output verbatim, so nothing has to interpret it", () => {
    const found = declaredRepair(pipelineWith(), "acceptance");
    if (!isDeclaredRepair(found)) throw new Error("expected a repair");
    expect(found.finding).toBe(OUTPUT);
  });

  it("offers nothing where the route declared no owner", () => {
    expect(declaredRepair(pipelineWith({ onFailure: undefined }), "acceptance")).toBe(
      "not-declared",
    );
  });

  it("offers nothing until something has actually failed", () => {
    const clean = pipelineWith({
      status: "awaiting-approval",
      subtasks: [
        { id: "acceptance-1", title: "Accept", prompt: "Accept.", status: "done" },
      ],
    } as Partial<TaskStage>);
    expect(declaredRepair(clean, "acceptance")).toBe("no-failure");
  });

  // A stage fails as soon as any subtask does while its siblings stay pending, so the
  // stage's own status is routinely `active` on a route that has stopped — the shape
  // `stagePresentation` had to be corrected for.
  it("finds the repair on a stage still reported active by its status", () => {
    const active = pipelineWith({
      status: "active",
      subtasks: [
        {
          id: "acceptance-1",
          title: "Accept",
          prompt: "Accept.",
          status: "failed",
          failureReason: OUTPUT,
        },
        { id: "acceptance-2", title: "Second", prompt: "Second.", status: "pending" },
      ],
    } as Partial<TaskStage>);
    expect(isDeclaredRepair(declaredRepair(active, "acceptance"))).toBe(true);
  });

  it("refuses an owner that produced nothing to correct", () => {
    const barren = pipelineWith();
    barren.stages[0] = stage({
      subtasks: [
        { id: "promote-1", title: "Promote", prompt: "Promote.", status: "done" },
      ],
    });
    expect(declaredRepair(barren, "acceptance")).toBe("nothing-to-correct");
  });

  // The declaration was validated against the route at load; a pipeline is a snapshot
  // that `repositionRouteStages` may since have permuted, so ordering is re-checked here.
  it("refuses an owner that is not an earlier stage of this pipeline", () => {
    const forward = pipelineWith({ onFailure: { repair: "later" } });
    forward.stages.push(stage({ id: "later", name: "Later", status: "pending" }));
    expect(declaredRepair(forward, "acceptance")).toBe("unknown-stage");
    expect(declaredRepair(pipelineWith({ onFailure: { repair: "gone" } }), "acceptance")).toBe(
      "unknown-stage",
    );
  });
});

describe("formatCheckFailureNote", () => {
  it("attributes the finding and says the sections reporting nothing need nothing", () => {
    const found = declaredRepair(pipelineWith(), "acceptance");
    if (!isDeclaredRepair(found)) throw new Error("expected a repair");
    const note = formatCheckFailureNote(found);
    expect(note).toContain('"UAT acceptance"');
    expect(note).toContain(OUTPUT);
    expect(note.toLowerCase()).toContain("nothing there to do");
  });
});
