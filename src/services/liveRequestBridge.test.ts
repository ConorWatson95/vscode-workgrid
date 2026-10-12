import { describe, expect, it } from "vitest";
import { TaskStage } from "../domain/taskPipeline";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { AskUserService, PendingAsk } from "./askUserService";
import { LiveRequestBridge } from "./liveRequestBridge";
import { PendingGate, PermissionGateService } from "./permissionGateService";

const AT = "2026-10-12T10:00:00.000Z";
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function stage(): TaskStage {
  return {
    id: "impl",
    name: "Implement",
    kind: "implementation",
    status: "active",
    intent: "do it",
    splittable: false,
    requiresApproval: false,
    subtasks: [{ id: "impl-1", title: "do it", prompt: "do it", status: "active" }],
  };
}

function task(id = "t1"): TaskWorkspace {
  return {
    id,
    name: "Task " + id,
    repositoryRoot: "C:/repo",
    worktreePath: "C:/w/" + id,
    branchName: "feat/" + id,
    baseBranch: "main",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    description: "The brief.",
    pipeline: { routeId: "r", stages: [stage()] },
  };
}

/** Just enough of the two services: what is waiting, and what was answered. */
function fakes() {
  const asks = new Map<string, PendingAsk>();
  const answered: { callId: string; answers: readonly string[] }[] = [];
  const holds: PendingGate[] = [];
  const decided: { id: string; decision: string; scope: string }[] = [];
  const gateListeners: (() => void)[] = [];
  const askUser = {
    onAsked: () => () => undefined,
    get: (id: string) => asks.get(id),
    answer: (id: string, answers: readonly string[]) => {
      answered.push({ callId: id, answers });
      return asks.delete(id);
    },
    abandon: () => 0,
  } as unknown as AskUserService;
  const permissionGate = {
    onChanged: (listener: () => void) => {
      gateListeners.push(listener);
      return () => undefined;
    },
    waiting: () => [...holds],
    decide: (id: string, decision: string, scope: string) => {
      const index = holds.findIndex((held) => held.request.id === id);
      if (index < 0) return false;
      holds.splice(index, 1);
      decided.push({ id, decision, scope });
      return true;
    },
  } as unknown as PermissionGateService;
  return { asks, answered, holds, decided, askUser, permissionGate };
}

async function setup(servesBrief?: (taskId: string) => boolean) {
  const repository = new InMemoryTaskRepository();
  await repository.save(task());
  const f = fakes();
  const delivered: boolean[] = [];
  const bridge = new LiveRequestBridge({
    repository,
    askUser: f.askUser,
    permissionGate: f.permissionGate,
    logger,
    now: () => new Date(AT),
    servesBrief,
    onAnswersDelivered: (_task, { live }) => delivered.push(live),
  });
  return { repository, bridge, delivered, ...f };
}

const ask: PendingAsk = {
  taskId: "t1",
  request: { id: "call-1", questions: ["Which tab?"], context: "The wireframe has three." },
  waitingSince: AT,
};

describe("LiveRequestBridge", () => {
  it("records a live question where every client's answer flow reads it", async () => {
    const { bridge, repository } = await setup();
    await bridge.recordQuestion(ask);
    const question = (await repository.get("t1"))?.pipeline?.pendingQuestion;
    expect(question?.liveCallId).toBe("call-1");
    expect(question?.stageName).toBe("Implement");
    expect(question?.items.map((item) => item.text)).toEqual(["Which tab?"]);
  });

  it("hands answers another client submitted to the call this process holds", async () => {
    const { bridge, repository, asks, answered, delivered } = await setup();
    asks.set("call-1", ask);
    await bridge.recordQuestion(ask);
    await repository.update("t1", (current) => {
      const question = current!.pipeline!.pendingQuestion!;
      return {
        ...current!,
        pipeline: {
          ...current!.pipeline!,
          pendingQuestion: {
            ...question,
            items: question.items.map((item) => ({ ...item, answer: "tab 3" })),
            submittedAt: AT,
          },
        },
      };
    });

    await bridge.serve("C:/repo");

    expect(answered).toEqual([{ callId: "call-1", answers: ["tab 3"] }]);
    expect(delivered).toEqual([true]);
    const after = await repository.get("t1");
    expect(after?.pipeline?.pendingQuestion).toBeUndefined();
    // Kept in the brief too: the next subtask is a fresh session.
    expect(after?.description).toContain("A: tab 3");
  });

  it("mirrors held calls, applies a decision written back, and clears the mirror", async () => {
    const { bridge, repository, holds, decided } = await setup();
    holds.push({
      taskId: "t1",
      request: { id: "g1", toolName: "Bash", toolInput: { command: "git push" } },
      callKey: "Bash:git push",
      detail: "git push",
      waitingSince: AT,
    });
    await bridge.mirrorHolds();
    expect((await repository.get("t1"))?.pipeline?.heldCalls?.map((call) => call.id)).toEqual(["g1"]);

    await repository.update("t1", (current) => ({
      ...current!,
      pipeline: {
        ...current!.pipeline!,
        heldCalls: current!.pipeline!.heldCalls!.map((call) => ({
          ...call,
          decision: { allow: true, scope: "session" as const, at: AT },
        })),
      },
    }));
    await bridge.serve("C:/repo");
    expect(decided).toEqual([{ id: "g1", decision: "allow", scope: "session" }]);

    await bridge.mirrorHolds();
    expect((await repository.get("t1"))?.pipeline?.heldCalls).toBeUndefined();
  });

  it("leaves another task's orphaned answers to a process that serves it", async () => {
    const { bridge, repository, delivered } = await setup((taskId) => taskId === "other");
    await bridge.recordQuestion(ask);
    await repository.update("t1", (current) => {
      const question = current!.pipeline!.pendingQuestion!;
      return {
        ...current!,
        pipeline: {
          ...current!.pipeline!,
          pendingQuestion: {
            ...question,
            items: question.items.map((item) => ({ ...item, answer: "tab 3" })),
            // Long enough ago that no process owns the call any more.
            submittedAt: "2026-10-12T09:00:00.000Z",
          },
        },
      };
    });
    await bridge.serve("C:/repo");
    expect(delivered).toEqual([]);
    expect((await repository.get("t1"))?.pipeline?.pendingQuestion?.submittedAt).toBeDefined();
  });
});
