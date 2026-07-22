import { describe, it, expect } from "vitest";
import { InMemoryTaskRepository } from "./taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";

function make(id: string, repositoryRoot: string): TaskWorkspace {
  return {
    id,
    name: id,
    repositoryRoot,
    worktreePath: `/w/${id}`,
    branchName: `feature/${id}`,
    baseBranch: "main",
    status: "ready",
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("InMemoryTaskRepository", () => {
  it("saves, updates, gets and deletes", async () => {
    const repo = new InMemoryTaskRepository();
    await repo.save(make("a", "/repos/x"));
    await repo.save({ ...make("a", "/repos/x"), name: "renamed" });
    expect((await repo.get("a"))?.name).toBe("renamed");
    await repo.delete("a");
    expect(await repo.get("a")).toBeUndefined();
  });

  it("filters by repository root case-insensitively", async () => {
    const repo = new InMemoryTaskRepository();
    await repo.save(make("a", "/repos/x"));
    await repo.save(make("b", "/repos/y"));
    const forX = await repo.getByRepository("\\REPOS\\x");
    expect(forX.map((t) => t.id)).toEqual(["a"]);
  });
});
