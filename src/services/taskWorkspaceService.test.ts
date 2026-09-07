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

// The worktree service is still stubbed — nothing here creates one. The status
// service is not: `adoptWorktree` and `createTaskFromBranch` now resolve the branch's
// base commit, so a stub that answers nothing would silently exercise only the
// fall-back path and assert the field into existence nowhere.
function makeService(
  repo: InMemoryTaskRepository,
  mergeBase: { ok: true; value: string } | { ok: false; error: unknown } = {
    ok: true,
    value: "base0000",
  },
) {
  let counter = 0;
  const clock: ServiceClock = {
    now: () => "2026-07-22T00:00:00.000Z",
    newId: () => `id-${++counter}`,
  };
  return new TaskWorkspaceService(
    repo,
    {} as never,
    { getMergeBase: async () => mergeBase } as never,
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

describe("createTaskFromBranch", () => {
  const REPO = "/repos/myrepo";

  function serviceWithGit(repo: InMemoryTaskRepository) {
    let counter = 0;
    const clock: ServiceClock = {
      now: () => "2026-08-07T00:00:00.000Z",
      newId: () => `id-${++counter}`,
    };
    const worktrees = {
      addWorktreeForBranch: async (
        _root: string,
        options: { branchName: string; worktreePath: string },
      ) => ({
        ok: true as const,
        value: { path: options.worktreePath, branch: options.branchName },
      }),
    };
    return new TaskWorkspaceService(
      repo,
      worktrees as never,
      { getMergeBase: async () => ({ ok: true, value: "base0000" }) } as never,
      noopLogger,
      clock,
    );
  }

  // The remaining way in: work done before this extension existed, or by a chat-only
  // task, has a branch and nothing else — no task, no worktree — and that is exactly
  // the work with no record of what was done to it.
  it("checks out the branch as it stands and records it as a task", async () => {
    const repo = new InMemoryTaskRepository();
    const created = await serviceWithGit(repo).createTaskFromBranch({
      repositoryRoot: REPO,
      name: "Parts scorecard",
      branchName: "feature/parts-scorecard",
      baseBranch: "DEV",
      configuredParentDir: "",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // The branch is kept exactly as given: nothing is rebased, merged or renamed,
    // because the work on it is the reason it matters.
    expect(created.value.branchName).toBe("feature/parts-scorecard");
    expect(created.value.baseBranch).toBe("DEV");
    expect(await repo.getByRepository(REPO)).toHaveLength(1);
  });

  it("refuses a branch another task already uses", async () => {
    const repo = new InMemoryTaskRepository();
    const first = await serviceWithGit(repo).createTaskFromBranch({
      repositoryRoot: REPO,
      name: "First",
      branchName: "feature/parts-scorecard",
      baseBranch: "DEV",
      configuredParentDir: "",
    });
    expect(first.ok).toBe(true);

    const second = await serviceWithGit(repo).createTaskFromBranch({
      repositoryRoot: REPO,
      name: "Again",
      branchName: "feature/parts-scorecard",
      baseBranch: "DEV",
      configuredParentDir: "",
    });
    expect(second.ok).toBe(false);
  });
});
