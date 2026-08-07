import { describe, expect, it } from "vitest";
import { approvalAdvice, formatApprovalAdvice } from "./approvalAdvice";
import { TaskPipeline, TaskStage } from "./taskPipeline";

const stage = (over: Partial<TaskStage> = {}): TaskStage =>
  ({
    id: "review",
    name: "SQL object review",
    kind: "domainReview",
    status: "awaiting-approval",
    intent: "Review it.",
    splittable: false,
    requiresApproval: true,
    subtasks: [],
    ...over,
  }) as TaskStage;

const withReply = (reply: string, over: Partial<TaskStage> = {}) =>
  stage({
    subtasks: [{ id: "review-1", title: "Review", prompt: "p", status: "done", reply }],
    ...over,
  });

const pipe = (stages: TaskStage[]): TaskPipeline =>
  ({ routeId: "sql-change", stages }) as TaskPipeline;

const implement = stage({
  id: "sc-change",
  name: "Make the change",
  kind: "implementation",
  status: "passed",
});

describe("approvalAdvice", () => {
  it("recommends sending findings back, naming the stage", () => {
    const review = withReply("### Critical: wrong stored procedure", {
      verdict: "block",
      sendBackTo: ["kind:implementation"],
    });
    const advice = approvalAdvice(pipe([implement, review]), review);

    expect(advice.action).toBe("sendBack");
    expect(advice.sendBackTo).toEqual({ id: "sc-change", name: "Make the change" });
    expect(advice.headline).toContain("1 critical");
    expect(advice.suggestion).toContain("Make the change");
    expect(advice.stated).toBe(true);
  });

  it("says so when there is nowhere to send the findings", () => {
    // Naming the config key matters: without it this reads as the feature being
    // broken rather than as a line of route config that was never written.
    const review = withReply("### Critical: wrong stored procedure", { verdict: "block" });
    const advice = approvalAdvice(pipe([implement, review]), review);

    expect(advice.action).toBe("decide");
    expect(advice.suggestion).toContain("sendBackTo");
  });

  it("marks an inferred conclusion as inferred", () => {
    // A stated verdict and one read out of prose warrant different confidence: the
    // inference has been wrong in both directions.
    const review = withReply("### Critical: wrong proc", {
      sendBackTo: ["kind:implementation"],
    });
    const advice = approvalAdvice(pipe([implement, review]), review);
    expect(advice.action).toBe("sendBack");
    expect(advice.stated).toBe(false);
    expect(formatApprovalAdvice(advice)).toContain("stated no verdict");
  });

  it("recommends approving when findings are only suggestions", () => {
    const review = withReply("### Suggestion: rename the column", { verdict: "pass" });
    const advice = approvalAdvice(pipe([implement, review]), review);
    expect(advice.action).toBe("approve");
    expect(advice.headline).toContain("none of it blocking");
  });

  it("recommends approving a clean review", () => {
    const review = withReply("Everything checks out.", { verdict: "pass" });
    const advice = approvalAdvice(pipe([implement, review]), review);
    expect(advice.action).toBe("approve");
    expect(advice.headline).toContain("passed the work");
    expect(advice.findings).toBeUndefined();
  });

  it("puts outstanding verification items ahead of everything at the gate", () => {
    // Approving over unticked evidence is the one thing the gate exists to prevent.
    const raised = stage({
      id: "behaviour",
      name: "Behaviour review",
      status: "passed",
      checklist: [
        { id: "c1", text: "Edit a customer", checked: false, raisedByStage: "behaviour" },
        { id: "c2", text: "Export a report", checked: true, raisedByStage: "behaviour" },
      ],
    } as Partial<TaskStage>);
    const gate = stage({ id: "gate", name: "Sign off", kind: "humanVerification" });
    const advice = approvalAdvice(pipe([raised, gate]), gate);

    expect(advice.action).toBe("verify");
    expect(advice.outstanding).toBe(1);
    expect(advice.headline).toContain("1 verification item");
  });

  it("does not count items from a skipped stage", () => {
    // They describe work no longer in the task, so they cannot be exercised.
    const skipped = stage({
      id: "behaviour",
      status: "skipped",
      checklist: [
        { id: "c1", text: "gone", checked: false, raisedByStage: "behaviour" },
      ],
    } as Partial<TaskStage>);
    const gate = stage({ id: "gate", name: "Sign off", kind: "humanVerification" });
    const advice = approvalAdvice(pipe([skipped, gate]), gate);

    expect(advice.action).toBe("approve");
    expect(advice.outstanding).toBe(0);
  });

  it("blocks on findings when the stage stated no verdict at all", () => {
    const review = withReply("### Important: the migration is unpaired", {
      sendBackTo: ["kind:implementation"],
    });
    expect(approvalAdvice(pipe([implement, review]), review).action).toBe("sendBack");
  });

  it("counts the work this stage declined, so it can be settled here", () => {
    // The route only holds on deferrals in front of a stage that ships, which is
    // right — but that hold used to be the only place they could be settled, so a
    // real run accumulated declines from 08:40 onward and asked twelve questions at
    // once immediately before a DEV push, about stages approved hours earlier.
    const p = pipe([implement, stage({ id: "review" })]);
    p.deferrals = [
      { id: "d1", text: "the export structure does not exist on live", raisedByStage: "sc-change", raisedByStageName: "Make the change", at: "t" },
      { id: "d2", text: "settled already", raisedByStage: "sc-change", raisedByStageName: "Make the change", at: "t", resolved: true, resolution: "publish does it" },
      { id: "d3", text: "someone else's", raisedByStage: "review", raisedByStageName: "Review", at: "t" },
    ] as TaskPipeline["deferrals"];

    // Only this stage's, and only the unsettled ones.
    expect(approvalAdvice(p, implement).declined).toBe(1);
  });

  it("names the declined work in the advice a reader sees", () => {
    const p = pipe([implement]);
    p.deferrals = [
      { id: "d1", text: "no deploy folder", raisedByStage: "sc-change", raisedByStageName: "Make the change", at: "t" },
    ] as TaskPipeline["deferrals"];

    expect(formatApprovalAdvice(approvalAdvice(p, implement))).toMatch(
      /1 item\(s\) this stage declined/,
    );
  });

  it("says nothing about declined work when there is none", () => {
    expect(formatApprovalAdvice(approvalAdvice(pipe([implement]), implement))).not.toMatch(
      /declined/,
    );
  });

  it("respects a stated pass over blocking-looking prose", () => {
    // The reviewer read its own report; the parser only guessed at it.
    const review = withReply("### Critical: pre-existing, not introduced here", {
      verdict: "pass",
      sendBackTo: ["kind:implementation"],
    });
    expect(approvalAdvice(pipe([implement, review]), review).action).toBe("approve");
  });
});
