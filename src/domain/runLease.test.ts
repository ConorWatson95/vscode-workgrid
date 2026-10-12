import { describe, expect, it } from "vitest";
import {
  RunLease,
  claimLease,
  clearStop,
  dropLease,
  leaseOwnerAlive,
  requestStop,
  stopRequested,
} from "./runLease";
import { TaskWorkspace } from "./taskWorkspace";

const AT = "2026-10-12T09:00:00.000Z";

const lease = (overrides: Partial<RunLease> = {}): RunLease => ({
  by: "headless",
  pid: 100,
  host: "box",
  processStartedAt: "2026-10-12T08:59:00.000Z",
  acquiredAt: AT,
  ...overrides,
});

function task(runLease?: RunLease, stopRequestedAt?: string): TaskWorkspace {
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
    pipeline: { routeId: "r", stages: [], runLease, stopRequestedAt },
  };
}

describe("claimLease", () => {
  it("takes a free task, and re-takes its own", () => {
    const taken = claimLease(task(), lease());
    expect(taken?.pipeline?.runLease?.pid).toBe(100);
    expect(claimLease(taken, lease({ acquiredAt: "later" }))?.pipeline?.runLease?.acquiredAt).toBe("later");
  });

  it("refuses a task somebody else holds", () => {
    expect(claimLease(task(lease({ pid: 7 })), lease())).toBeUndefined();
  });

  it("takes over only from the exact holder the caller found dead", () => {
    const held = lease({ pid: 7 });
    expect(claimLease(task(held), lease(), held)?.pipeline?.runLease?.pid).toBe(100);
    // Somebody else took it between the probe and the write.
    expect(claimLease(task(lease({ pid: 8 })), lease(), held)).toBeUndefined();
  });

  it("will not lease a task with no route", () => {
    expect(claimLease({ ...task(), pipeline: undefined }, lease())).toBeUndefined();
  });
});

describe("dropLease", () => {
  it("drops only its own lease", () => {
    expect(dropLease(task(lease()), lease())?.pipeline?.runLease).toBeUndefined();
    expect(dropLease(task(lease({ pid: 7 })), lease())).toBeUndefined();
  });
});

describe("leaseOwnerAlive", () => {
  const owner = lease();
  it("is dead when the pid is gone", () => {
    expect(leaseOwnerAlive(owner, "box", { pid: 100, alive: false })).toBe(false);
  });
  it("is dead when the pid now belongs to a process that started much later", () => {
    expect(
      leaseOwnerAlive(owner, "box", { pid: 100, alive: true, osStartedAt: "2026-10-12T11:00:00.000Z" }),
    ).toBe(false);
  });
  it("is alive when the start time matches, or cannot be read", () => {
    expect(
      leaseOwnerAlive(owner, "box", { pid: 100, alive: true, osStartedAt: "2026-10-12T08:59:01.000Z" }),
    ).toBe(true);
    expect(leaseOwnerAlive(owner, "box", { pid: 100, alive: true })).toBe(true);
  });
  it("is assumed alive on another host or without a probe", () => {
    expect(leaseOwnerAlive(owner, "elsewhere", { pid: 100, alive: false })).toBe(true);
    expect(leaseOwnerAlive(owner, "box", undefined)).toBe(true);
  });
});

describe("stop requests", () => {
  it("is only recorded while a run holds the task", () => {
    expect(requestStop(task(), AT)).toBeUndefined();
    expect(requestStop(task(lease()), AT)?.pipeline?.stopRequestedAt).toBe(AT);
  });

  it("reaches the owner, and a request older than its lease does not", () => {
    expect(stopRequested(task(lease(), AT), lease())).toBe(true);
    expect(stopRequested(task(lease(), "2026-10-12T08:00:00.000Z"), lease())).toBe(false);
    expect(stopRequested(task(lease({ pid: 7 }), AT), lease())).toBe(false);
  });

  it("is cleared once honoured", () => {
    expect(clearStop(task(lease(), AT))?.pipeline?.stopRequestedAt).toBeUndefined();
  });
});
