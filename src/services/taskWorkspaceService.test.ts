import { describe, it, expect } from "vitest";
import { TaskWorkspaceService, ServiceClock } from "./taskWorkspaceService";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { Logger } from "../logging/logger";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// adoptWorktree and proposeTask never touch git, so the git services can be
// stubbed; only the repository is exercised here.
function makeService(repo: InMemoryTaskRepository) {
  let counter = 0;
  const clock: ServiceClock = {
    now: () => "2026-07-22T00:00:00.000Z",
    newId: () => `id-${++counter}`,
  };
  return new TaskWorkspaceService(
    repo,
    {} as never,
    {} as never,
    noopLogger,
    clock,
  );
}

describe("proposeTask", () => {
  it("computes branch and path for preview", () => {
    const service = makeService(new InMemoryTaskRepository());
    const result = service.proposeTask({
      repositoryRoot: "/repos/myrepo",
      name: "Campaign Report",
      branchPrefix: "feature",
      configuredParentDir: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branchName).toBe("feature/campaign-report");
      expect(result.value.slug).toBe("campaign-report");
    }
  });
});

describe("adoptWorktree", () => {
  it("creates a tracked task from an untracked worktree", async () => {
    const repo = new InMemoryTaskRepository();
    const service = makeService(repo);
    const result = await service.adoptWorktree(
      "/repos/myrepo",
      "/repos/myrepo-loose",
      "feature/loose",
      { name: "Loose Work", baseBranch: "main" },
    );
    expect(result.ok).toBe(true);
    const stored = await repo.getByRepository("/repos/myrepo");
    expect(stored).toHaveLength(1);
    expect(stored[0].branchName).toBe("feature/loose");
  });

  it("rejects a worktree that is already tracked", async () => {
    const repo = new InMemoryTaskRepository();
    const service = makeService(repo);
    await service.adoptWorktree("/repos/myrepo", "/repos/myrepo-loose", "b", {
      name: "First",
      baseBranch: "main",
    });
    const again = await service.adoptWorktree(
      "/repos/myrepo",
      "\\repos\\MYREPO-loose", // same path, different case/separators
      "b",
      { name: "Second", baseBranch: "main" },
    );
    expect(again.ok).toBe(false);
  });
});
