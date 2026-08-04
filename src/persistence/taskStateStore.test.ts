import { describe, expect, it } from "vitest";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Result, err, ok } from "../utilities/result";
import { StateFileIo } from "./fileTaskRepository";
import { InMemoryTaskRepository, TaskRepository } from "./taskRepository";
import { taskStateFilePath } from "./taskStateFile";
import {
  GitCommonDirSource,
  RoutedTaskRepository,
  TaskStateStore,
} from "./taskStateStore";

class FakeIo implements StateFileIo {
  readonly files = new Map<string, string>();
  writeCount = 0;

  async read(filePath: string): Promise<string | undefined> {
    return this.files.get(filePath);
  }

  async write(filePath: string, contents: string): Promise<void> {
    this.writeCount++;
    this.files.set(filePath, contents);
  }
}

class FakeGit implements GitCommonDirSource {
  calls = 0;
  constructor(private readonly dirs: Record<string, string | undefined>) {}

  async getGitCommonDir(repositoryRoot: string): Promise<Result<string, unknown>> {
    this.calls++;
    const dir = this.dirs[repositoryRoot];
    return dir ? ok(dir) : err({ kind: "validation", message: "no git dir" });
  }
}

function task(id: string, repositoryRoot: string): TaskWorkspace {
  return {
    id,
    name: id,
    repositoryRoot,
    worktreePath: `${repositoryRoot}/wt/${id}`,
    branchName: `feat/${id}`,
    baseBranch: "main",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function legacyWith(...tasks: TaskWorkspace[]): Promise<TaskRepository> {
  const repo = new InMemoryTaskRepository();
  for (const t of tasks) await repo.save(t);
  return repo;
}

const ROOT = "C:/repo";
const GIT_DIR = "C:/repo/.git";

describe("TaskStateStore", () => {
  it("adopts the Memento's tasks for this repository on first open", async () => {
    const io = new FakeIo();
    const store = new TaskStateStore({
      io,
      git: new FakeGit({ [ROOT]: GIT_DIR }),
      legacy: await legacyWith(task("mine", ROOT), task("theirs", "C:/other")),
    });

    const repository = await store.forRepository(ROOT);

    expect((await repository.getAll()).map((t) => t.id)).toEqual(["mine"]);
  });

  it("leaves the Memento intact, so a bad adoption is recoverable", async () => {
    const legacy = await legacyWith(task("mine", ROOT));
    const store = new TaskStateStore({
      io: new FakeIo(),
      git: new FakeGit({ [ROOT]: GIT_DIR }),
      legacy,
    });

    await store.forRepository(ROOT);

    expect((await legacy.getAll()).map((t) => t.id)).toEqual(["mine"]);
  });

  it("does not re-adopt once a state file exists, so deletions stick", async () => {
    const io = new FakeIo();
    const legacy = await legacyWith(task("mine", ROOT));
    const git = new FakeGit({ [ROOT]: GIT_DIR });

    const first = await new TaskStateStore({ io, git, legacy }).forRepository(ROOT);
    await first.delete("mine");

    // A fresh store, as if the window had been reopened.
    const second = await new TaskStateStore({ io, git, legacy }).forRepository(ROOT);

    expect(await second.getAll()).toEqual([]);
  });

  it("writes nothing when there is nothing to adopt", async () => {
    const io = new FakeIo();
    const store = new TaskStateStore({
      io,
      git: new FakeGit({ [ROOT]: GIT_DIR }),
      legacy: await legacyWith(task("theirs", "C:/other")),
    });

    await store.forRepository(ROOT);

    expect(io.writeCount).toBe(0);
    expect(io.files.has(taskStateFilePath(GIT_DIR))).toBe(false);
  });

  it("resolves the git directory once per repository", async () => {
    const git = new FakeGit({ [ROOT]: GIT_DIR });
    const store = new TaskStateStore({ io: new FakeIo(), git });

    await store.forRepository(ROOT);
    await store.forRepository("c:\\repo\\");

    expect(git.calls).toBe(1);
  });

  it("shares one adoption between concurrent callers", async () => {
    const io = new FakeIo();
    const store = new TaskStateStore({
      io,
      git: new FakeGit({ [ROOT]: GIT_DIR }),
      legacy: await legacyWith(task("mine", ROOT)),
    });

    await Promise.all([store.forRepository(ROOT), store.forRepository(ROOT)]);

    expect(io.writeCount).toBe(1);
  });

  it("rejects when the git directory cannot be resolved", async () => {
    const store = new TaskStateStore({ io: new FakeIo(), git: new FakeGit({}) });
    await expect(store.forRepository("C:/not-a-repo")).rejects.toThrow(/git directory/);
  });

  it("retries after a failed resolution instead of caching the failure", async () => {
    const git = new FakeGit({});
    const store = new TaskStateStore({ io: new FakeIo(), git });

    await expect(store.forRepository(ROOT)).rejects.toThrow();
    await expect(store.forRepository(ROOT)).rejects.toThrow();

    expect(git.calls).toBe(2);
  });

  it("keeps working when the legacy store throws", async () => {
    const broken: TaskRepository = {
      getAll: async () => {
        throw new Error("memento exploded");
      },
      getByRepository: async () => [],
      get: async () => undefined,
      save: async () => undefined,
      delete: async () => undefined,
    };
    const store = new TaskStateStore({
      io: new FakeIo(),
      git: new FakeGit({ [ROOT]: GIT_DIR }),
      legacy: broken,
    });

    const repository = await store.forRepository(ROOT);

    expect(await repository.getAll()).toEqual([]);
  });
});

describe("RoutedTaskRepository", () => {
  it("routes to the resolved store", async () => {
    const target = new InMemoryTaskRepository();
    const fallback = new InMemoryTaskRepository();
    const routed = new RoutedTaskRepository(async () => target, fallback);

    await routed.save(task("t1", ROOT));

    expect(await target.getAll()).toHaveLength(1);
    expect(await fallback.getAll()).toHaveLength(0);
  });

  it("uses the fallback when no repository is active", async () => {
    const fallback = new InMemoryTaskRepository();
    const routed = new RoutedTaskRepository(async () => undefined, fallback);

    await routed.save(task("t1", ROOT));

    expect(await fallback.getAll()).toHaveLength(1);
  });

  it("follows the active repository when it changes", async () => {
    const first = new InMemoryTaskRepository();
    const second = new InMemoryTaskRepository();
    let active = first;
    const routed = new RoutedTaskRepository(
      async () => active,
      new InMemoryTaskRepository(),
    );

    await routed.save(task("a", ROOT));
    active = second;
    await routed.save(task("b", ROOT));

    expect((await first.getAll()).map((t) => t.id)).toEqual(["a"]);
    expect((await second.getAll()).map((t) => t.id)).toEqual(["b"]);
  });
});
