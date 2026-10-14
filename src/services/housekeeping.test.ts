import { describe, expect, it } from "vitest";
import { createPipeline } from "../domain/pipelineEngine";
import { BUILT_IN_ROUTES, RouteDefinition } from "../domain/taskRoute";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { Housekeeping, HousekeepingDeps } from "./housekeeping";

const ROOT = "C:/repo";
const AT = "2026-10-12T09:00:00.000Z";
const route = BUILT_IN_ROUTES[0];

function task(id: string, over: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id,
    name: id,
    repositoryRoot: ROOT,
    worktreePath: `C:/wt/${id}`,
    branchName: `feat/${id}`,
    baseBranch: "main",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    pipeline: createPipeline(route),
    ...over,
  };
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function setup(over: Partial<HousekeepingDeps> = {}, leased: string[] = []) {
  const repository = new InMemoryTaskRepository();
  const reclaimedFrom: string[] = [];
  const swept: { active: ReadonlySet<string>; running?: ReadonlySet<string> }[] = [];
  const housekeeping = new Housekeeping({
    repository,
    runner: {
      reclaimStale: async (t) => (reclaimedFrom.push(t.id), { reclaimed: [1] }),
    },
    leases: { heldElsewhere: async (t) => (t && leased.includes(t.id) ? { pid: 1 } : undefined) },
    feedback: { poll: async () => ({ arrived: [] }) },
    agentProcesses: {
      sweep: async (active, running) => void swept.push({ active, running }),
    },
    definitions: () => undefined,
    feedbackPollMinutes: () => 15,
    logger: quiet,
    now: () => AT,
    ...over,
  });
  return { housekeeping, repository, reclaimedFrom, swept };
}

describe("Housekeeping.reclaimStale", () => {
  it("leaves a task another live process is running to that process", async () => {
    const { housekeeping, repository, reclaimedFrom } = setup({}, ["busy"]);
    await repository.save(task("idle"));
    await repository.save(task("busy"));
    await repository.save(task("chat", { pipeline: undefined }));

    expect(await housekeeping.reclaimStale(ROOT)).toBe(1);
    expect(reclaimedFrom).toEqual(["idle"]);
  });

  it("is a repair, so its own failure reports nothing rather than throwing", async () => {
    const { housekeeping, repository } = setup({
      runner: { reclaimStale: async () => Promise.reject(new Error("disk")) },
    });
    await repository.save(task("idle"));
    expect(await housekeeping.reclaimStale(ROOT)).toBe(0);
  });
});

describe("Housekeeping.pollFeedback", () => {
  it("does not poll when the setting is zero", async () => {
    let polled = 0;
    const { housekeeping } = setup({
      feedbackPollMinutes: () => 0,
      feedback: { poll: async () => (polled++, { arrived: [] }) },
    });
    await housekeeping.pollFeedback(ROOT);
    expect(polled).toBe(0);
  });
});

describe("Housekeeping.syncRouteConfig", () => {
  it("renames a stage on a task in flight and saves only the task that changed", async () => {
    const renamed: RouteDefinition = {
      ...route,
      stages: route.stages.map((stage, index) =>
        index === 0 ? { ...stage, label: "Renamed first stage" } : stage,
      ),
    };
    const { housekeeping, repository } = setup({
      definitions: () => ({ routes: [renamed], rules: [] }),
    });
    await repository.save(task("old"));
    await repository.save(task("other-route", { pipeline: { ...createPipeline(route), routeId: "nope" } }));

    const corrected = await housekeeping.syncRouteConfig(ROOT);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatch(/^old: /);
    expect((await repository.get("old"))?.pipeline?.stages[0].name).toBe("Renamed first stage");
    expect((await repository.get("other-route"))?.updatedAt).toBe(AT);
  });

  it("does nothing when config cannot be read", async () => {
    const { housekeeping, repository } = setup();
    await repository.save(task("old"));
    expect(await housekeeping.syncRouteConfig(ROOT)).toEqual([]);
  });
});

describe("Housekeeping.deliverOrphanedAnswers", () => {
  // The live case: a headless run asked, died, was reclaimed, and the operator then
  // answered from Claude. Nothing was running to collect the answer, so it sat.
  function asked(id: string, subtaskStatus: "active" | "pending", over: object = {}): TaskWorkspace {
    const base = task(id);
    const stage = base.pipeline!.stages[0];
    return {
      ...base,
      description: "Brief.",
      pipeline: {
        ...base.pipeline!,
        stages: [
          { ...stage, subtasks: [{ id: "sub-1", title: "x", brief: "x", status: subtaskStatus }] },
          ...base.pipeline!.stages.slice(1),
        ] as never,
        pendingQuestion: {
          stageId: stage.id,
          stageName: stage.name,
          subtaskId: "sub-1",
          askedAt: AT,
          items: [{ id: "q1", text: "Promote or skip?", answer: "Skip" }],
          liveCallId: "call-1",
          submittedAt: AT,
          ...over,
        },
      },
    };
  }

  it("puts an answer for a session that is gone into the brief", async () => {
    const { housekeeping, repository } = setup();
    await repository.save(asked("gone", "pending"));

    const delivered = await housekeeping.deliverOrphanedAnswers(ROOT);

    expect(delivered.map((t) => t.id)).toEqual(["gone"]);
    const saved = await repository.get("gone");
    expect(saved?.pipeline?.pendingQuestion).toBeUndefined();
    expect(saved?.description).toContain(["Q: Promote or skip?", "A: Skip"].join("\n"));
  });

  it("leaves an answer a running session is still waiting on, and one not yet submitted", async () => {
    const { housekeeping, repository } = setup();
    await repository.save(asked("live", "active"));
    await repository.save(asked("draft", "pending", { submittedAt: undefined }));

    expect(await housekeeping.deliverOrphanedAnswers(ROOT)).toEqual([]);
    expect((await repository.get("live"))?.pipeline?.pendingQuestion).toBeDefined();
    expect((await repository.get("draft"))?.pipeline?.pendingQuestion).toBeDefined();
  });

  it("leaves a task another live process holds to that process", async () => {
    const { housekeeping, repository } = setup({}, ["busy"]);
    await repository.save(asked("busy", "pending"));

    expect(await housekeeping.deliverOrphanedAnswers(ROOT)).toEqual([]);
  });
});

describe("Housekeeping.sweepAgentProcesses", () => {
  it("passes active subtasks, and tasks held elsewhere, as off limits", async () => {
    const { housekeeping, repository, swept } = setup({}, ["busy"]);
    const running = task("idle");
    running.pipeline!.stages[0].subtasks = [
      { id: "sub-1", title: "x", brief: "x", status: "active" },
    ] as never;
    await repository.save(running);
    await repository.save(task("busy"));

    await housekeeping.sweepAgentProcesses(ROOT);
    expect([...swept[0].active]).toEqual(["sub-1"]);
    expect([...(swept[0].running ?? [])]).toEqual(["busy"]);
  });
});

describe("Housekeeping.tick", () => {
  it("runs every job and reports what each did", async () => {
    const { housekeeping, repository, swept } = setup({
      feedback: { poll: async () => ({ arrived: [task("waiting", { origin: { sourceId: "j", ref: "NMGB-1", at: AT } })] }) },
    });
    await repository.save(task("idle"));

    const report = await housekeeping.tick(ROOT);
    expect(report).toEqual({
      reclaimed: 1,
      answersDelivered: [],
      feedbackArrived: ["NMGB-1"],
      configSynced: [],
    });
    expect(swept).toHaveLength(1);
  });
});
