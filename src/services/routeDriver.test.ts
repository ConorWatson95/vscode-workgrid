import { describe, expect, it } from "vitest";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { PipelineRunner, RunReport } from "./pipelineRunner";
import { driveRoute } from "./routeDriver";
import { RunLeaseService } from "./runLeaseService";

const AT = "2026-10-12T09:00:00.000Z";
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function task(): TaskWorkspace {
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
    pipeline: { routeId: "r", stages: [] },
  };
}

/** A runner that records what it saw and lets the test act mid-run. */
function fakeRunner(during: () => Promise<void> = async () => {}) {
  const seen: { leasedBy?: string; cancelled: string[] } = { cancelled: [] };
  const runner = {
    isRunning: () => false,
    cancel: (taskId: string) => seen.cancelled.push(taskId),
    advance: async (advancing: TaskWorkspace): Promise<RunReport> => {
      seen.leasedBy = advancing.pipeline?.runLease?.by;
      await during();
      return { outcome: { kind: "complete" }, steps: ["ran"], denials: [] } as unknown as RunReport;
    },
  } as unknown as PipelineRunner;
  return { runner, seen };
}

const alive = async (pids: readonly number[]) => pids.map((pid) => ({ pid, alive: true, osStartedAt: AT }));

describe("driveRoute", () => {
  it("runs under a lease and gives it back however the run ends", async () => {
    const repository = new InMemoryTaskRepository();
    await repository.save(task());
    const { runner, seen } = fakeRunner();
    const leases = new RunLeaseService(repository, "headless", alive, { pid: 1, processStartedAt: AT });

    const result = await driveRoute(
      { repository, runner, leases, definitions: () => undefined, logger, now: () => AT },
      "t1",
    );
    expect(result.kind).toBe("ran");
    expect(seen.leasedBy).toBe("headless");
    expect((await repository.get("t1"))?.pipeline?.runLease).toBeUndefined();
  });

  it("refuses a task another live process is advancing, and runs nothing", async () => {
    const repository = new InMemoryTaskRepository();
    await repository.save(task());
    await new RunLeaseService(repository, "vscode", alive, { pid: 2, processStartedAt: AT }).acquire("t1", AT);
    const { runner, seen } = fakeRunner();
    const leases = new RunLeaseService(repository, "headless", alive, { pid: 1, processStartedAt: AT });

    const result = await driveRoute(
      { repository, runner, leases, definitions: () => undefined, logger, now: () => AT },
      "t1",
    );
    expect(result).toMatchObject({ kind: "refused", message: expect.stringContaining("VS Code (pid 2)") });
    expect(seen.leasedBy).toBeUndefined();
    expect((await repository.get("t1"))?.pipeline?.runLease?.pid).toBe(2);
  });

  it("cancels its own run when another client asks it to stop", async () => {
    const repository = new InMemoryTaskRepository();
    await repository.save(task());
    let changed: (() => void) | undefined;
    const leases = new RunLeaseService(repository, "headless", alive, { pid: 1, processStartedAt: AT });
    const { runner, seen } = fakeRunner(async () => {
      await leases.requestStop("t1", AT);
      changed?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await driveRoute(
      {
        repository,
        runner,
        leases,
        definitions: () => undefined,
        logger,
        now: () => AT,
        watchState: (onChange) => {
          changed = onChange;
          return () => (changed = undefined);
        },
      },
      "t1",
    );
    expect(seen.cancelled).toEqual(["t1"]);
    // Released with the lease, so it cannot cancel the next run the moment it starts.
    expect((await repository.get("t1"))?.pipeline?.stopRequestedAt).toBeUndefined();
  });
});
