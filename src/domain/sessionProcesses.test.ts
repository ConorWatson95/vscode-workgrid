import { describe, expect, it } from "vitest";
import {
  decideSessionProcesses as decideRaw,
  ProbedProcess,
  SessionProcessRecord,
  summariseSessionProcesses,
} from "./sessionProcesses";

const AT = "2026-08-26T10:00:00.000Z";
const HERE = "C:/Dev/repo";

/**
 * Every production sweep has a repository — `extension.ts` returns early without one
 * — so the default here matches the record factory, and the cases below read as they
 * always did. The repository-scoping cases pass their own.
 */
const decideSessionProcesses = (
  records: readonly SessionProcessRecord[],
  probes: readonly ProbedProcess[],
  activeSubtaskIds: ReadonlySet<string>,
  root: string | undefined = HERE,
) => decideRaw(records, probes, activeSubtaskIds, root);

const record = (over: Partial<SessionProcessRecord> = {}): SessionProcessRecord => ({
  pid: 100,
  taskId: "t1",
  subtaskId: "build-1",
  stageName: "Implement the data",
  startedAt: AT,
  repositoryRoot: "c:/dev/repo",
  ...over,
});

const probe = (over: Partial<ProbedProcess> = {}): ProbedProcess => ({
  pid: 100,
  alive: true,
  osStartedAt: AT,
  ...over,
});

const active = (...ids: string[]) => new Set(ids);

describe("decideSessionProcesses", () => {
  it("kills a live process whose subtask is no longer running", () => {
    const [decision] = decideSessionProcesses([record()], [probe()], active());
    expect(decision.action).toBe("kill");
    expect(decision.reason).toContain("Implement the data");
  });

  it("keeps a process whose subtask is still running", () => {
    const [decision] = decideSessionProcesses([record()], [probe()], active("build-1"));
    expect(decision.action).toBe("keep");
    expect(decision.reason).toContain("still running");
  });

  it("forgets a record whose process has exited", () => {
    const [decision] = decideSessionProcesses(
      [record()],
      [probe({ alive: false })],
      active(),
    );
    expect(decision.action).toBe("forget");
  });

  it("forgets a record with no probe at all rather than assuming it is alive", () => {
    const [decision] = decideSessionProcesses([record()], [], active());
    expect(decision.action).toBe("forget");
  });

  it("never kills a hand-driven session, which has no subtask", () => {
    // Unreapable by construction: with no subtask there is nothing to have gone
    // inactive. The runtime narrows a stage, never a person.
    const [decision] = decideSessionProcesses(
      [record({ subtaskId: undefined })],
      [probe()],
      active(),
    );
    expect(decision.action).toBe("keep");
    expect(decision.reason).toContain("hand-driven");
  });

  it("forgets a reused pid instead of killing whatever now holds it", () => {
    // The failure this exists to prevent: a crashed host leaves a record, the pid is
    // recycled, and a name-blind sweep kills the operator's chat session.
    const [decision] = decideSessionProcesses(
      [record()],
      [probe({ osStartedAt: "2026-08-26T14:00:00.000Z" })],
      active(),
    );
    expect(decision.action).toBe("forget");
    expect(decision.reason).toContain("reused");
  });

  it("tolerates a small clock difference between the two readings", () => {
    const [decision] = decideSessionProcesses(
      [record()],
      [probe({ osStartedAt: "2026-08-26T10:00:20.000Z" })],
      active(),
    );
    expect(decision.action).toBe("kill");
  });

  it("keeps an orphan the platform could not identify, rather than killing on liveness", () => {
    const [decision] = decideSessionProcesses(
      [record()],
      [probe({ osStartedAt: undefined })],
      active(),
    );
    expect(decision.action).toBe("keep");
    expect(decision.reason).toContain("cannot confirm");
  });

  it("decides each record independently", () => {
    const decisions = decideSessionProcesses(
      [
        record({ pid: 1, subtaskId: "a" }),
        record({ pid: 2, subtaskId: "b" }),
        record({ pid: 3, subtaskId: undefined }),
      ],
      [
        probe({ pid: 1 }),
        probe({ pid: 2 }),
        probe({ pid: 3 }),
      ],
      active("b"),
    );
    expect(decisions.map((d) => d.action)).toEqual(["kill", "keep", "keep"]);
  });
});

describe("summariseSessionProcesses", () => {
  it("says nothing when nothing was reaped", () => {
    const decisions = decideSessionProcesses([record()], [probe()], active("build-1"));
    expect(summariseSessionProcesses(decisions)).toBeUndefined();
  });

  it("names the pids it killed, because a kill must never be silent", () => {
    const decisions = decideSessionProcesses(
      [record({ pid: 7 }), record({ pid: 9 })],
      [probe({ pid: 7 }), probe({ pid: 9 })],
      active(),
    );
    const line = summariseSessionProcesses(decisions)!;
    expect(line).toContain("reaped 2");
    expect(line).toContain("7, 9");
  });

  it("reports the ones it left alone unidentified", () => {
    const decisions = decideSessionProcesses(
      [record()],
      [probe({ osStartedAt: undefined })],
      active(),
    );
    expect(summariseSessionProcesses(decisions)).toContain("could not confirm");
  });
});

describe("decideSessionProcesses across windows", () => {
  it("leaves a process recorded by a window open on another repository", () => {
    // The registry is machine-global, so this window reads that record; `active` can
    // only come from this repository, so a subtask still running there looks finished.
    const [decision] = decideSessionProcesses(
      [record({ repositoryRoot: "c:/dev/other" })],
      [probe()],
      active(),
    );
    expect(decision.action).toBe("keep");
    expect(decision.reason).toContain("another repository");
  });

  it("still kills its own repository's orphan despite case and separators", () => {
    const [decision] = decideSessionProcesses([record()], [probe()], active(), "C:\\Dev\\Repo\\");
    expect(decision.action).toBe("kill");
  });

  it("keeps a record written before the repository was stamped", () => {
    const [decision] = decideSessionProcesses(
      [record({ repositoryRoot: undefined })],
      [probe()],
      active(),
    );
    expect(decision.action).toBe("keep");
    expect(decision.reason).toContain("which repository");
  });

  it("keeps everything when the sweeping window has no repository", () => {
    // `decideRaw`, not the wrapper: passing `undefined` to a defaulted parameter
    // takes the default, which is the arity this case exists to exercise. The
    // production sweep returns early without a root, so this is belt and braces.
    const [decision] = decideRaw([record()], [probe()], active());
    expect(decision.action).toBe("keep");
  });

  it("forgets a dead process whichever repository owned it", () => {
    const [decision] = decideSessionProcesses(
      [record({ repositoryRoot: "c:/dev/other" })],
      [probe({ alive: false })],
      active(),
    );
    expect(decision.action).toBe("forget");
  });
});
