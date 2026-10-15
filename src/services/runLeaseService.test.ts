import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { RunLeaseService } from "./runLeaseService";

const AT = "2026-10-12T09:00:00.000Z";

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

async function repository(): Promise<InMemoryTaskRepository> {
  const repo = new InMemoryTaskRepository();
  await repo.save(task());
  return repo;
}

const me = { pid: 1, processStartedAt: AT };
const other = { pid: 2, processStartedAt: AT };

describe("RunLeaseService", () => {
  it("lets exactly one of two processes take a task", async () => {
    const repo = await repository();
    const alive = async () => [{ pid: 1, alive: true, osStartedAt: AT }, { pid: 2, alive: true, osStartedAt: AT }];
    const first = new RunLeaseService(repo, "vscode", alive, me);
    const second = new RunLeaseService(repo, "headless", alive, other);

    expect((await first.acquire("t1", AT)).ok).toBe(true);
    const refused = await second.acquire("t1", AT);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("VS Code (pid 1)");
    expect(await second.heldElsewhere(await repo.get("t1"))).toMatchObject({ pid: 1 });
  });

  it("takes over from a holder the OS says is gone, and drops its stale stop request", async () => {
    const repo = await repository();
    await new RunLeaseService(repo, "headless", async () => [], other).acquire("t1", AT);
    await new RunLeaseService(repo, "headless", async () => [], other).requestStop("t1", AT);

    const dead = async (pids: readonly number[]) => pids.map((pid) => ({ pid, alive: false }));
    const taken = await new RunLeaseService(repo, "vscode", dead, me).acquire("t1", AT);
    expect(taken.ok && taken.task.pipeline?.runLease?.pid).toBe(1);
    expect(taken.ok && taken.task.pipeline?.stopRequestedAt).toBeUndefined();
  });

  it("drops a dead holder's lease and its stop request, and keeps a live one's", async () => {
    const repo = await repository();
    await new RunLeaseService(repo, "headless", async () => [], other).acquire("t1", AT);
    await new RunLeaseService(repo, "headless", async () => [], other).requestStop("t1", AT);

    const living = async (pids: readonly number[]) => pids.map((pid) => ({ pid, alive: true, osStartedAt: AT }));
    expect(await new RunLeaseService(repo, "vscode", living, me).releaseDead((await repo.get("t1"))!)).toBe(false);
    expect((await repo.get("t1"))?.pipeline?.runLease?.pid).toBe(2);

    const dead = async (pids: readonly number[]) => pids.map((pid) => ({ pid, alive: false }));
    expect(await new RunLeaseService(repo, "vscode", dead, me).releaseDead((await repo.get("t1"))!)).toBe(true);
    expect((await repo.get("t1"))?.pipeline?.runLease).toBeUndefined();
    expect((await repo.get("t1"))?.pipeline?.stopRequestedAt).toBeUndefined();
  });

  it("never drops its own lease as dead", async () => {
    const repo = await repository();
    const dead = async (pids: readonly number[]) => pids.map((pid) => ({ pid, alive: false }));
    const mine = new RunLeaseService(repo, "vscode", dead, me);
    await mine.acquire("t1", AT);
    expect(await mine.releaseDead((await repo.get("t1"))!)).toBe(false);
    expect((await repo.get("t1"))?.pipeline?.runLease?.pid).toBe(1);
  });

  it("keeps a holder whose liveness could not be probed", async () => {
    const repo = await repository();
    await new RunLeaseService(repo, "headless", async () => [], other).acquire("t1", AT);
    const failing = async () => {
      throw new Error("no powershell");
    };
    expect((await new RunLeaseService(repo, "vscode", failing, me).acquire("t1", AT)).ok).toBe(false);
  });

  it("releases only its own lease", async () => {
    const repo = await repository();
    const holder = new RunLeaseService(repo, "headless", async () => [], other);
    await holder.acquire("t1", AT);
    await new RunLeaseService(repo, "vscode", async () => [], me).release("t1");
    expect((await repo.get("t1"))?.pipeline?.runLease?.pid).toBe(2);
    await holder.release("t1");
    expect((await repo.get("t1"))?.pipeline?.runLease).toBeUndefined();
  });

  it("records the host it runs on", async () => {
    const repo = await repository();
    const taken = await new RunLeaseService(repo, "headless", async () => [], me).acquire("t1", AT, "C:/log");
    expect(taken.ok && taken.task.pipeline?.runLease).toMatchObject({ host: os.hostname(), logPath: "C:/log" });
  });
});
