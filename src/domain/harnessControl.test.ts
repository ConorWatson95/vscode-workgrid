import { describe, expect, it } from "vitest";
import {
  decideApproval,
  decideChecklistItem,
  decideCorrection,
  decideRerun,
  decideRetry,
  decideSendBack,
  isRetryable,
} from "./harnessControl";
import { pipelineRevision } from "./pipelineRevision";
import { Subtask, TaskPipeline, TaskStage } from "./taskPipeline";
import { TaskWorkspace } from "./taskWorkspace";

const AT = "2026-10-08T10:00:00.000Z";

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  return { id: "s1", title: "do it", prompt: "do it", status: "done", ...overrides };
}

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "gate",
    name: "Sign off",
    kind: "codeReview",
    status: "awaiting-approval",
    intent: "review it",
    splittable: false,
    requiresApproval: true,
    subtasks: [subtask()],
    ...overrides,
  };
}

function task(stages: TaskStage[]): TaskWorkspace {
  const pipeline: TaskPipeline = { routeId: "r", stages };
  return {
    id: "t1",
    name: "Task one",
    repositoryRoot: "C:/repo",
    worktreePath: "C:/repo-worktrees/t1",
    branchName: "feat/one",
    baseBranch: "main",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    pipeline,
  };
}

const rev = (t: TaskWorkspace) => pipelineRevision(t.pipeline);

describe("pipelineRevision", () => {
  it("is stable for equal pipelines and moves when one changes", () => {
    const a = task([stage()]);
    const b = task([stage()]);
    expect(rev(a)).toBe(rev(b));
    expect(rev(task([stage({ status: "passed" })]))).not.toBe(rev(a));
  });
});

describe("decideApproval", () => {
  it("approves a gate through the engine, against the revision it was shown", () => {
    const t = task([stage()]);
    const outcome = decideApproval(t, { stageId: "gate", revision: rev(t), at: AT, note: " ship it " });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.changed).toBe(true);
    const approved = outcome.value.task.pipeline!;
    expect(approved.stages[0].status).toBe("passed");
    // The engine's own records, not ours: the note becomes guidance and the act an
    // intervention, exactly as when the extension approves.
    expect(approved.guidance?.map((g) => g.text)).toEqual(["ship it"]);
    expect(approved.interventions?.some((i) => i.kind === "approval")).toBe(true);
  });

  it("refuses when the run moved since it was shown", () => {
    const shown = task([stage(), stage({ id: "next", name: "Next", status: "pending" })]);
    const now = task([stage(), stage({ id: "next", name: "Next", status: "pending", intent: "changed" })]);

    const outcome = decideApproval(now, { stageId: "gate", revision: rev(shown), at: AT });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("stale");
  });

  it("reports a second approval of one gate as already done, writing nothing", () => {
    const t = task([stage()]);
    const shownRevision = rev(t);
    const first = decideApproval(t, { stageId: "gate", revision: shownRevision, at: AT });
    if (!first.ok) throw new Error("first approval failed");

    // The other client still holds the revision it rendered.
    const second = decideApproval(first.value.task, { stageId: "gate", revision: shownRevision, at: AT });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.changed).toBe(false);
    expect(second.value.task).toBe(first.value.task);
  });

  it("refuses while a session is running on the pipeline", () => {
    const t = task([
      stage(),
      stage({ id: "impl", name: "Implement", status: "active", subtasks: [subtask({ status: "active" })] }),
    ]);
    const outcome = decideApproval(t, { stageId: "gate", revision: rev(t), at: AT });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("inFlight");
  });

  it("keeps the gate's own checklist rule", () => {
    const t = task([
      stage({
        kind: "humanVerification",
        checklist: [{ id: "c1", text: "the grid totals match", checked: false }],
      }),
    ]);
    const outcome = decideApproval(t, { stageId: "gate", revision: rev(t), at: AT });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("refused");
    expect(outcome.error.message).toContain("the grid totals match");
  });

  it("leaves a stage owing a pull request URL to the client that can ask for one", () => {
    const t = task([
      stage({
        kind: "deployment",
        requiresPullRequest: true,
        subtasks: [subtask({ reply: "Promoted the commits and pushed the branch." })],
      }),
    ]);
    const outcome = decideApproval(t, { stageId: "gate", revision: rev(t), at: AT });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("needsPullRequest");
  });

  it("names a vanished task and an unknown stage", () => {
    expect(decideApproval(undefined, { stageId: "gate", revision: "x", at: AT }).ok).toBe(false);
    const t = task([stage()]);
    const outcome = decideApproval(t, { stageId: "nope", revision: rev(t), at: AT });
    expect(!outcome.ok && outcome.error.kind).toBe("unknownStage");
  });
});

describe("decideRetry", () => {
  it("offers retry on exactly the shapes the tree does", () => {
    expect(isRetryable(stage({ status: "failed" }))).toBe(true);
    expect(
      isRetryable(stage({ status: "active", subtasks: [subtask({ status: "failed" }), subtask({ id: "s2", status: "pending" })] })),
    ).toBe(true);
    expect(isRetryable(stage({ status: "active", subtasks: [subtask({ status: "pending" })] }))).toBe(false);
    expect(isRetryable(stage({ status: "passed" }))).toBe(false);
  });

  it("re-opens the failed units and carries the failure forward", () => {
    const t = task([
      stage({
        id: "impl",
        name: "Implement",
        kind: "implementation",
        status: "failed",
        requiresApproval: false,
        subtasks: [subtask({ status: "failed", failureReason: "exit 2: build broke" })],
      }),
    ]);
    const outcome = decideRetry(t, { stageId: "impl", revision: rev(t), at: AT });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const retried = outcome.value.task.pipeline!;
    expect(retried.stages[0].status).toBe("pending");
    expect(retried.stages[0].subtasks[0].status).toBe("pending");
    expect(retried.guidance?.[0].text).toContain("build broke");
  });

  it("refuses a stage that is no longer failed, whatever revision it carries", () => {
    const t = task([stage({ status: "passed" })]);
    const outcome = decideRetry(t, { stageId: "gate", revision: rev(t), at: AT });
    expect(!outcome.ok && outcome.error.kind).toBe("notRetryable");
  });
});

describe("decideChecklistItem", () => {
  const withItem = (checked: boolean) =>
    task([stage({ kind: "humanVerification", checklist: [{ id: "c1", text: "totals match", checked }] })]);

  it("ticks through the engine and stamps when", () => {
    const outcome = decideChecklistItem(withItem(false), { itemId: "c1", checked: true, at: AT });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const item = outcome.value.task.pipeline!.stages[0].checklist![0];
    expect(item.checked).toBe(true);
    expect(item.checkedAt).toBe(AT);
  });

  it("is a no-op when the item already says so", () => {
    const t = withItem(true);
    const outcome = decideChecklistItem(t, { itemId: "c1", checked: true, at: AT });
    expect(outcome.ok && outcome.value.changed).toBe(false);
  });

  it("refuses an item that has gone", () => {
    const outcome = decideChecklistItem(withItem(false), { itemId: "zz", checked: true, at: AT });
    expect(outcome.ok).toBe(false);
  });
});

describe("repairs", () => {
  // Built, reviewed with a critical, and one stage still to come.
  function reviewed(review: Partial<TaskStage> = {}): TaskWorkspace {
    return task([
      stage({
        id: "impl",
        name: "Implement",
        kind: "implementation",
        status: "passed",
        requiresApproval: false,
        subtasks: [subtask({ id: "impl-1", reply: "Wrote the export." })],
      }),
      stage({
        sendBackTo: ["impl"],
        subtasks: [subtask({ id: "gate-1", reply: "## Critical\n- the total double-counts returns" })],
        ...review,
      }),
      stage({ id: "ship", name: "Ship", kind: "deployment", status: "pending", subtasks: [] }),
    ]);
  }

  it("files a correction through the engine, keeping the stage's work", () => {
    const t = reviewed();
    const outcome = decideCorrection(t, {
      stageId: "impl",
      revision: rev(t),
      finding: "the total column double-counts returns",
      at: AT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const impl = outcome.value.task.pipeline!.stages[0];
    expect(impl.subtasks.map((s) => s.reply)).toContain("Wrote the export.");
    expect(impl.subtasks.some((s) => s.correction?.finding.includes("double-counts"))).toBe(true);
    expect(outcome.value.message).toMatch(/1 later stage\(s\) re-opened/);
  });

  it("refuses a finding that names nothing, since it is the session's whole brief", () => {
    const t = reviewed();
    const outcome = decideCorrection(t, { stageId: "impl", revision: rev(t), finding: "Incorrect.", at: AT });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("weakBrief");
  });

  it("refuses to correct a stage that produced nothing", () => {
    const t = reviewed();
    const outcome = decideCorrection(t, {
      stageId: "ship",
      revision: rev(t),
      finding: "it deployed the wrong project",
      at: AT,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("notCorrectable");
  });

  it("re-runs a stage with the reason filed as guidance for it alone", () => {
    const t = reviewed();
    const outcome = decideRerun(t, { stageId: "impl", revision: rev(t), reason: "use tab 3", at: AT });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const pipeline = outcome.value.task.pipeline!;
    expect(pipeline.stages.map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
    expect(pipeline.guidance?.find((g) => g.text === "use tab 3")?.scope).toBe("stage");
  });

  it("sends a review's findings back as a fix, keeping the target's work", () => {
    const t = reviewed();
    const outcome = decideSendBack(t, {
      fromStageId: "gate",
      targetStageId: "impl",
      revision: rev(t),
      how: "fix",
      at: AT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const impl = outcome.value.task.pipeline!.stages[0];
    const fix = impl.subtasks.find((s) => s.correction);
    expect(fix?.correction?.finding).toMatch(/Sent back from "Sign off"/);
    expect(fix?.correction?.finding).toMatch(/double-counts/);
  });

  it("sends findings back to re-run, carrying them as the target's guidance", () => {
    const t = reviewed();
    const outcome = decideSendBack(t, {
      fromStageId: "gate",
      targetStageId: "impl",
      revision: rev(t),
      how: "rerun",
      at: AT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const pipeline = outcome.value.task.pipeline!;
    expect(pipeline.stages[0].status).toBe("pending");
    expect(pipeline.guidance?.some((g) => g.stageId === "impl" && /double-counts/.test(g.text))).toBe(true);
  });

  it("refuses a target the route does not offer", () => {
    const t = reviewed({ sendBackTo: [] });
    const outcome = decideSendBack(t, {
      fromStageId: "gate",
      targetStageId: "impl",
      revision: rev(t),
      how: "fix",
      at: AT,
    });
    expect(outcome.ok).toBe(false);
  });

  it("asks a gate that recorded nothing for what went wrong", () => {
    const t = reviewed({ kind: "humanVerification", subtasks: [] });
    const without = decideSendBack(t, {
      fromStageId: "gate",
      targetStageId: "impl",
      revision: rev(t),
      how: "fix",
      at: AT,
    });
    expect(without.ok).toBe(false);

    const withFindings = decideSendBack(t, {
      fromStageId: "gate",
      targetStageId: "impl",
      revision: rev(t),
      how: "fix",
      findings: "Specified cast is not valid opening the report",
      at: AT,
    });
    expect(withFindings.ok).toBe(true);
  });

  it("refuses all three against a run that moved", () => {
    const t = reviewed();
    const stale = "not-the-revision";
    expect(decideCorrection(t, { stageId: "impl", revision: stale, finding: "the total is wrong here", at: AT }).ok).toBe(false);
    expect(decideRerun(t, { stageId: "impl", revision: stale, at: AT }).ok).toBe(false);
    expect(
      decideSendBack(t, { fromStageId: "gate", targetStageId: "impl", revision: stale, how: "fix", at: AT }).ok,
    ).toBe(false);
  });
});
