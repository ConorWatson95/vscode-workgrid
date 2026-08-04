import { describe, expect, it } from "vitest";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { FileTaskRepository, StateFileIo } from "./fileTaskRepository";
import { taskStateFilePath, taskStateQuarantinePath } from "./taskStateFile";

const GIT_DIR = "/repo/.git";
const STATE = taskStateFilePath(GIT_DIR);
const QUARANTINE = taskStateQuarantinePath(GIT_DIR);

/** In-memory StateFileIo that records writes, so ordering is assertable. */
class FakeIo implements StateFileIo {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  failWritesTo?: string;

  async read(filePath: string): Promise<string | undefined> {
    return this.files.get(filePath);
  }

  async write(filePath: string, contents: string): Promise<void> {
    if (this.failWritesTo === filePath) {
      throw new Error("disk full");
    }
    this.writes.push(filePath);
    this.files.set(filePath, contents);
  }
}

function task(overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id: "t1",
    name: "Task one",
    repositoryRoot: "C:/repo",
    worktreePath: "C:/repo-worktrees/t1",
    branchName: "feat/one",
    baseBranch: "main",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function repo(io: StateFileIo, logger?: { info(m: string): void }) {
  return new FileTaskRepository(GIT_DIR, io, logger, () => "2026-06-01T00:00:00.000Z");
}

describe("FileTaskRepository", () => {
  it("treats an absent file as an empty store", async () => {
    const subject = repo(new FakeIo());
    expect(await subject.getAll()).toEqual([]);
  });

  it("round-trips a saved task", async () => {
    const io = new FakeIo();
    const subject = repo(io);
    const saved = task({ description: "with a description" });

    await subject.save(saved);

    expect(await subject.get("t1")).toEqual(saved);
    expect(io.files.has(STATE)).toBe(true);
  });

  it("writes state under the git dir, never the working tree", async () => {
    const io = new FakeIo();
    await repo(io).save(task());

    expect(io.writes).toEqual([STATE]);
    expect(STATE.replace(/\\/g, "/")).toContain("/.git/task-workspaces/");
  });

  it("updates in place rather than appending a duplicate", async () => {
    const io = new FakeIo();
    const subject = repo(io);

    await subject.save(task());
    await subject.save(task({ name: "Renamed" }));

    const all = await subject.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Renamed");
  });

  it("deletes by id", async () => {
    const io = new FakeIo();
    const subject = repo(io);
    await subject.save(task());
    await subject.save(task({ id: "t2" }));

    await subject.delete("t1");

    expect((await subject.getAll()).map((t) => t.id)).toEqual(["t2"]);
  });

  it("does not write when deleting an unknown id", async () => {
    const io = new FakeIo();
    const subject = repo(io);
    await subject.save(task());
    const writesAfterSave = io.writes.length;

    await subject.delete("nope");

    expect(io.writes).toHaveLength(writesAfterSave);
  });

  it("filters by repository root, case- and separator-insensitively", async () => {
    const io = new FakeIo();
    const subject = repo(io);
    await subject.save(task({ id: "mine", repositoryRoot: "C:/repo" }));
    await subject.save(task({ id: "theirs", repositoryRoot: "C:/other" }));

    const found = await subject.getByRepository("c:\\repo\\");

    expect(found.map((t) => t.id)).toEqual(["mine"]);
  });

  it("sees a write made by another process, holding no cache", async () => {
    const io = new FakeIo();
    const first = repo(io);
    const second = repo(io);

    await first.getAll(); // prime any cache that might exist
    await second.save(task({ id: "from-cli" }));

    expect((await first.getAll()).map((t) => t.id)).toEqual(["from-cli"]);
  });

  it("preserves a concurrently added task when saving a different one", async () => {
    const io = new FakeIo();
    const extension = repo(io);
    const cli = repo(io);
    await extension.save(task({ id: "existing" }));

    // Each save re-reads first, so the CLI's task survives the extension's
    // next write instead of being overwritten by a stale in-memory list.
    await cli.save(task({ id: "from-cli" }));
    await extension.save(task({ id: "from-extension" }));

    expect((await extension.getAll()).map((t) => t.id).sort()).toEqual([
      "existing",
      "from-cli",
      "from-extension",
    ]);
  });

  it("quarantines an unreadable file instead of losing it", async () => {
    const io = new FakeIo();
    io.files.set(STATE, "{ not json");
    const notes: string[] = [];

    const tasks = await repo(io, { info: (m) => notes.push(m) }).getAll();

    expect(tasks).toEqual([]);
    const parked = JSON.parse(io.files.get(QUARANTINE) ?? "{}");
    expect(parked.entries).toEqual(["{ not json"]);
    expect(parked.quarantinedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(notes.join(" ")).toContain("quarantin");
  });

  it("still returns tasks when the quarantine write fails", async () => {
    const io = new FakeIo();
    io.files.set(STATE, "not json at all");
    io.failWritesTo = QUARANTINE;

    await expect(repo(io).getAll()).resolves.toEqual([]);
  });
});
