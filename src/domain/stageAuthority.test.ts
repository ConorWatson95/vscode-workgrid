import { describe, expect, it } from "vitest";
import { certifyStage } from "./stageAuthority";
import { TaskPipeline, TaskStage } from "./taskPipeline";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "review",
    name: "Code review",
    kind: "codeReview",
    status: "awaiting-approval",
    intent: "Review it.",
    splittable: false,
    requiresApproval: true,
    authority: "evidence",
    subtasks: [{ id: "review-1", title: "Review", prompt: "p", status: "done" }],
    ...overrides,
  };
}

function pipeline(stages: TaskStage[], deferrals: TaskPipeline["deferrals"] = []): TaskPipeline {
  return {
    routeId: "r",
    routeLabel: "R",
    stages,
    deferrals,
    updatedAt: "2026-09-01T00:00:00.000Z",
  } as TaskPipeline;
}

describe("certifyStage", () => {
  it("passes a declared evidence gate with nothing outstanding against it", () => {
    const result = certifyStage(pipeline([stage()]), "review");
    expect(result.admissible).toBe(true);
    expect(result.reason).toBe("nothing outstanding against it");
  });

  // The rule that keeps this from changing anything nobody asked for. Every route in
  // existence predates the field, so absence has to mean exactly the old behaviour.
  it("refuses a gate that declares no authority, which is every existing route", () => {
    const result = certifyStage(pipeline([stage({ authority: undefined })]), "review");
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("human authority boundary");
  });

  it("refuses one declared human even where the evidence is clean", () => {
    expect(certifyStage(pipeline([stage({ authority: "human" })]), "review").admissible).toBe(
      false,
    );
  });

  it("names the check that backed it, so an unattended pass can be read afterwards", () => {
    const result = certifyStage(
      pipeline([
        stage({
          verify: "build.ps1",
          verification: { command: "build.ps1", exitCode: 0, at: "2026-09-01T00:00:00.000Z" },
          verdict: "pass",
        }),
      ]),
      "review",
    );
    expect(result.admissible).toBe(true);
    expect(result.reason).toContain("build.ps1 exited 0");
    expect(result.reason).toContain("VERDICT: pass");
  });

  it("refuses a declared check that never ran, whatever it would have returned", () => {
    const result = certifyStage(pipeline([stage({ verify: "build.ps1" })]), "review");
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("never ran");
  });

  it("refuses a check that ran and failed", () => {
    const result = certifyStage(
      pipeline([
        stage({
          verify: "build.ps1",
          verification: { command: "build.ps1", exitCode: 2, at: "2026-09-01T00:00:00.000Z" },
        }),
      ]),
      "review",
    );
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("exited 2");
  });

  it("refuses a stage held for findings", () => {
    const result = certifyStage(
      pipeline([stage({ blocked: "the migration cannot be run on UAT" })]),
      "review",
    );
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("cannot be run on UAT");
  });

  it("refuses a stated VERDICT: block", () => {
    expect(certifyStage(pipeline([stage({ verdict: "block" })]), "review").admissible).toBe(false);
  });

  // The asymmetry that separates this from the runner's hold. There, a stated verdict
  // outranks parsed severities so a route does not stop for nothing. Here, holding
  // costs a click and passing costs the thing the review existed to prevent.
  it("refuses parsed criticals even where the reviewer stated VERDICT: pass", () => {
    const result = certifyStage(
      pipeline([
        stage({
          verdict: "pass",
          subtasks: [
            {
              id: "review-1",
              title: "Review",
              prompt: "p",
              status: "done",
              reply: "**Critical**\n- purchases are double-counted for duplicated Level2Code",
            },
          ],
        }),
      ]),
      "review",
    );
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("critical");
  });

  it("refuses while this stage has declined work nobody has settled", () => {
    const result = certifyStage(
      pipeline(
        [stage()],
        [
          {
            id: "d1",
            text: "nobody owns the rebuild",
            raisedByStage: "review",
            raisedByStageName: "Code review",
            at: "2026-09-01T00:00:00.000Z",
          },
        ],
      ),
      "review",
    );
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("declined 1 item");
  });

  // Another stage's deferral holds in front of a deployment, which is `nextAction`'s
  // job. It must not hold this gate, or one declined item anywhere would stop every
  // evidence gate in the route.
  it("passes while another stage's deferral is outstanding", () => {
    const result = certifyStage(
      pipeline(
        [stage()],
        [
          {
            id: "d1",
            text: "nobody owns the rebuild",
            raisedByStage: "implement",
            raisedByStageName: "Implement",
            at: "2026-09-01T00:00:00.000Z",
          },
        ],
      ),
      "review",
    );
    expect(result.admissible).toBe(true);
  });

  it("refuses a settled deferral no differently from having none", () => {
    const result = certifyStage(
      pipeline(
        [stage()],
        [
          {
            id: "d1",
            text: "nobody owns the rebuild",
            raisedByStage: "review",
            raisedByStageName: "Code review",
            at: "2026-09-01T00:00:00.000Z",
            resolved: true,
            resolution: "raised as its own ticket",
          },
        ],
      ),
      "review",
    );
    expect(result.admissible).toBe(true);
  });

  it("refuses a stage that is not at a gate at all", () => {
    const result = certifyStage(pipeline([stage({ status: "active" })]), "review");
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("not awaiting approval");
  });

  it("refuses an unknown stage rather than throwing", () => {
    expect(certifyStage(pipeline([stage()]), "nope").admissible).toBe(false);
  });

  // The bug this was written from: `approveStage` applies an assessment's conclusions
  // by marking stages *skipped*, so certifying one automatically would skip stages on
  // an agent's reading of a diff with nobody having read the evidence.
  it("never certifies an assessment, however the route declares it", () => {
    const result = certifyStage(
      pipeline([stage({ kind: "assessment", authority: "evidence" })]),
      "review",
    );
    expect(result.admissible).toBe(false);
    expect(result.reason).toContain("always a human's");
  });

  it("never certifies a human verification gate", () => {
    const result = certifyStage(
      pipeline([stage({ kind: "humanVerification", authority: "evidence" })]),
      "review",
    );
    expect(result.admissible).toBe(false);
  });
});
