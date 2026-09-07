import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProbedProcess } from "../domain/sessionProcesses";
import { SessionProcessRegistry } from "./sessionProcessRegistry";

const logger = () => {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
      debug: (m: string) => lines.push(`debug ${m}`),
    },
  };
};

describe("SessionProcessRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-procs-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const make = (
    over: {
      probe?: (pids: readonly number[]) => Promise<ProbedProcess[]>;
      kill?: (pid: number) => void;
    } = {},
  ) => {
    const log = logger();
    const killed: number[] = [];
    const registry = new SessionProcessRegistry({
      directory: dir,
      logger: log.logger,
      now: () => "2026-08-26T10:00:00.000Z",
      // The registry is machine-global, so a record carries the repository whose
      // window wrote it and the sweep only reaps its own — see
      // `SessionProcessRecord.repositoryRoot`.
      repositoryRoot: () => "C:/Dev/repo",
      kill: over.kill ?? ((pid) => killed.push(pid)),
      probe: over.probe ?? (async (pids) => pids.map((pid) => ({ pid, alive: true, osStartedAt: "2026-08-26T10:00:00.000Z" }))),
    });
    return { registry, killed, log };
  };

  it("records a session and reaps it once its subtask is not running", async () => {
    const { registry, killed } = make();
    await registry.record({ pid: 4321, taskId: "t1", subtaskId: "build-1", stageName: "Build" });

    await registry.sweep(new Set());

    expect(killed).toEqual([4321]);
    // The record leaves with the process, so a second sweep is a no-op.
    await registry.sweep(new Set());
    expect(killed).toEqual([4321]);
  });

  it("leaves a session whose subtask is still running, and keeps its record", async () => {
    const { registry, killed } = make();
    await registry.record({ pid: 55, taskId: "t1", subtaskId: "build-1" });

    await registry.sweep(new Set(["build-1"]));
    expect(killed).toEqual([]);

    // Still recorded, so it is reconsidered next time.
    await registry.sweep(new Set());
    expect(killed).toEqual([55]);
  });

  it("never kills a hand-driven session", async () => {
    const { registry, killed } = make();
    await registry.record({ pid: 77, taskId: "t1" });
    await registry.sweep(new Set());
    expect(killed).toEqual([]);
  });

  it("forgets a record whose process has gone", async () => {
    const { registry, killed } = make({ probe: async (pids) => pids.map((pid) => ({ pid, alive: false })) });
    await registry.record({ pid: 99, taskId: "t1", subtaskId: "s" });
    await registry.sweep(new Set());
    expect(killed).toEqual([]);
  });

  it("does not kill a recycled pid", async () => {
    const { registry, killed } = make({
      probe: async (pids) =>
        pids.map((pid) => ({ pid, alive: true, osStartedAt: "2026-08-26T15:00:00.000Z" })),
    });
    await registry.record({ pid: 12, taskId: "t1", subtaskId: "s" });
    await registry.sweep(new Set());
    expect(killed).toEqual([]);
  });

  it("forget() clears a cleanly stopped session", async () => {
    const { registry, killed } = make();
    await registry.record({ pid: 8, taskId: "t1", subtaskId: "s" });
    await registry.forget(8);
    await registry.sweep(new Set());
    expect(killed).toEqual([]);
  });

  it("announces a kill, because terminating something must never be silent", async () => {
    const { registry, log } = make();
    await registry.record({ pid: 31, taskId: "t1", subtaskId: "s", stageName: "Deploy" });
    await registry.sweep(new Set());
    const text = log.lines.join("\n");
    expect(text).toContain("31");
    expect(text).toContain("Deploy");
    expect(text).toContain("reaped 1");
  });

  it("survives an unreadable registry rather than failing activation", async () => {
    await fs.writeFile(path.join(dir, "agent-processes.json"), "{not json", "utf8");
    const { registry, killed } = make();
    await registry.sweep(new Set());
    expect(killed).toEqual([]);
  });

  it("survives a probe that throws", async () => {
    const { registry, killed, log } = make({
      probe: async () => {
        throw new Error("no OS for you");
      },
    });
    await registry.record({ pid: 5, taskId: "t1", subtaskId: "s" });
    await registry.sweep(new Set());
    expect(killed).toEqual([]);
    expect(log.lines.join("\n")).toContain("could not sweep");
  });

  it("keeps sweeping after one kill fails", async () => {
    const attempted: number[] = [];
    const { registry, log } = make({
      kill: (pid) => {
        attempted.push(pid);
        if (pid === 1) throw new Error("access denied");
      },
    });
    await registry.record({ pid: 1, taskId: "t1", subtaskId: "a" });
    await registry.record({ pid: 2, taskId: "t1", subtaskId: "b" });
    await registry.sweep(new Set());
    expect(attempted).toEqual([1, 2]);
    expect(log.lines.join("\n")).toContain("could not kill agent process 1");
  });

  it("replaces an earlier record for the same pid", async () => {
    const { registry, killed } = make();
    await registry.record({ pid: 3, taskId: "t1", subtaskId: "old" });
    await registry.record({ pid: 3, taskId: "t1", subtaskId: "new" });
    // Only the newer record survives, so "old" being inactive cannot kill it while
    // "new" is running.
    await registry.sweep(new Set(["new"]));
    expect(killed).toEqual([]);
  });

  it("keeps both of two sessions recorded at once", async () => {
    const { registry } = make();
    // `create()` fires these off without awaiting, so they routinely overlap. Both
    // used to read the same array and the second write dropped the first — measured
    // as four live stage sessions against one record.
    await Promise.all([
      registry.record({ pid: 11, taskId: "t1", subtaskId: "a" }),
      registry.record({ pid: 12, taskId: "t2", subtaskId: "b" }),
    ]);
    const written = JSON.parse(
      await fs.readFile(path.join(dir, "agent-processes.json"), "utf8"),
    ) as { pid: number }[];
    expect(written.map((r) => r.pid).sort()).toEqual([11, 12]);
  });

  it("does not erase a session recorded while the sweep was probing", async () => {
    let releaseProbe: () => void = () => undefined;
    const probing = new Promise<void>((r) => {
      releaseProbe = r;
    });
    const { registry, killed } = make({
      probe: async (pids) => {
        await probing;
        return pids.map((pid) => ({ pid, alive: true, osStartedAt: "2026-08-26T10:00:00.000Z" }));
      },
    });
    await registry.record({ pid: 21, taskId: "t1", subtaskId: "gone" });

    const swept = registry.sweep(new Set());
    // A real probe is a PowerShell spawn taking seconds; a session spawned inside that
    // window has a record the sweep has never seen, and writing back its decided list
    // erased it — leaving a live stage session no later sweep could ever reap.
    await registry.record({ pid: 22, taskId: "t2", subtaskId: "started-meanwhile" });
    releaseProbe();
    await swept;

    const written = JSON.parse(
      await fs.readFile(path.join(dir, "agent-processes.json"), "utf8"),
    ) as { pid: number }[];
    expect(killed).toEqual([21]);
    expect(written.map((r) => r.pid)).toEqual([22]);
  });
});
