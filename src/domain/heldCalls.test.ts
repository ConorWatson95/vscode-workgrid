import { describe, expect, it } from "vitest";
import { decideHeldCall } from "./harnessControl";
import { HeldCall, liveHeldCalls, syncHeldCalls } from "./heldCalls";
import { TaskPipeline, TaskStage, normalizePipeline } from "./taskPipeline";
import { TaskWorkspace } from "./taskWorkspace";

const AT = "2026-10-12T10:00:00.000Z";

function stage(status: "active" | "pending" = "active"): TaskStage {
  return {
    id: "impl",
    name: "Implement",
    kind: "implementation",
    status,
    intent: "do it",
    splittable: false,
    requiresApproval: false,
    subtasks: [{ id: "impl-1", title: "do it", prompt: "do it", status }],
  };
}

function pipeline(heldCalls?: HeldCall[], status: "active" | "pending" = "active"): TaskPipeline {
  return { routeId: "r", stages: [stage(status)], ...(heldCalls ? { heldCalls } : {}) };
}

function task(p: TaskPipeline): TaskWorkspace {
  return {
    id: "t1",
    name: "Task",
    repositoryRoot: "C:/repo",
    worktreePath: "C:/w/t1",
    branchName: "feat/t1",
    baseBranch: "main",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    pipeline: p,
  };
}

const bash = { id: "c1", tool: "Bash", detail: "git push", waitingSince: AT };

describe("syncHeldCalls", () => {
  it("mirrors what is held, and writes nothing when it has not changed", () => {
    const synced = syncHeldCalls(pipeline(), [bash]);
    expect(synced?.heldCalls).toEqual([bash]);
    expect(syncHeldCalls(synced!, [bash])).toBeUndefined();
  });

  it("keeps a decision on its way to a call still waiting", () => {
    const decision = { allow: true, scope: "once" as const, at: AT };
    const synced = syncHeldCalls(pipeline([{ ...bash, decision }]), [bash]);
    expect(synced).toBeUndefined();
  });

  it("drops the field once nothing is held, and the decision with it", () => {
    const decided = pipeline([{ ...bash, decision: { allow: false, scope: "once", at: AT } }]);
    const cleared = syncHeldCalls(decided, []);
    expect(cleared).toBeDefined();
    expect("heldCalls" in cleared!).toBe(false);
  });

  it("survives a reload", () => {
    expect(normalizePipeline(pipeline([bash])).heldCalls).toEqual([bash]);
  });
});

describe("liveHeldCalls", () => {
  it("hides calls a dead process left behind once nothing is running", () => {
    expect(liveHeldCalls(pipeline([bash]))).toHaveLength(1);
    expect(liveHeldCalls(pipeline([bash], "pending"))).toEqual([]);
  });
});

describe("decideHeldCall", () => {
  it("records the decision for the holder to apply", () => {
    const decided = decideHeldCall(task(pipeline([bash])), { callId: "c1", allow: true, scope: "session", at: AT });
    expect(decided.ok && decided.value.task.pipeline?.heldCalls?.[0].decision).toEqual({
      allow: true,
      scope: "session",
      at: AT,
    });
  });

  it("refuses a call that is no longer held, and does not decide one twice", () => {
    const gone = decideHeldCall(task(pipeline()), { callId: "c1", allow: true, scope: "once", at: AT });
    expect(!gone.ok && gone.error.kind).toBe("stale");

    const once = { allow: false, scope: "once" as const, at: AT };
    const again = decideHeldCall(task(pipeline([{ ...bash, decision: once }])), {
      callId: "c1",
      allow: true,
      scope: "once",
      at: AT,
    });
    expect(again.ok && again.value.changed).toBe(false);
  });
});
