import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { runnerLogPath } from "../runner/headlessHost";
import { RunLauncher } from "./runLauncher";

const AT = "2026-10-12T09:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

async function launcher(onLaunch: (repository: InMemoryTaskRepository, log: string) => Promise<void> | void) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-"));
  dirs.push(storageDir);
  const log = runnerLogPath(storageDir, "t1");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // An earlier run's account, which must not be read as this one's.
  fs.writeFileSync(log, "old not advanced: from yesterday\n");
  const repository = new InMemoryTaskRepository();
  await repository.save(task());
  let clock = Date.parse(AT);
  return new RunLauncher({
    repository,
    repositoryRoot: "C:/repo",
    storageDir,
    runnerScript: "runner.js",
    launch: async () => onLaunch(repository, log),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeoutMs: 2_000,
  });
}

describe("RunLauncher", () => {
  it("reports a start once the runner holds the task", async () => {
    const started = await (
      await launcher(async (repository) => {
        await repository.update("t1", (t) => ({
          ...t,
          pipeline: {
            ...t.pipeline!,
            runLease: { by: "headless", pid: 42, host: "box", processStartedAt: AT, acquiredAt: AT },
          },
        }));
      })
    ).start("t1");
    expect(started).toEqual({ ok: true, message: "Advancing in a headless runner (pid 42)." });
  });

  it("passes on the runner's own refusal, and only this launch's", async () => {
    const started = await (
      await launcher((_repository, log) => {
        fs.appendFileSync(log, "x warn  not advanced: VS Code (pid 7) has been advancing this route\n");
      })
    ).start("t1");
    expect(started).toEqual({ ok: false, message: "VS Code (pid 7) has been advancing this route" });
  });

  it("counts a run that finished between two polls as started", async () => {
    const started = await (
      await launcher((_repository, log) => {
        fs.appendFileSync(log, 'x info  stopped: {"kind":"awaitingApproval"}\nx info  --- exit 0\n');
      })
    ).start("t1");
    expect(started.ok).toBe(true);
  });

  it("says it may still be starting when nothing has happened by the deadline", async () => {
    const started = await (await launcher(() => undefined)).start("t1");
    expect(started.ok).toBe(false);
    expect(started.message).toMatch(/may still be starting/);
  });
});
