import { describe, it, expect } from "vitest";
import { reconcileTasks } from "./taskReconciliationService";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { GitWorktree } from "../git/types";

function task(overrides: Partial<TaskWorkspace>): TaskWorkspace {
  return {
    id: "id",
    name: "Task",
    repositoryRoot: "/repos/myrepo",
    worktreePath: "/repos/myrepo-task",
    branchName: "feature/task",
    baseBranch: "main",
    status: "ready",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

function worktree(overrides: Partial<GitWorktree>): GitWorktree {
  return {
    path: "/repos/myrepo-task",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    ...overrides,
  };
}

const repoRoot = "/repos/myrepo";

describe("reconcileTasks", () => {
  it("matches a task to its worktree (case/slash-insensitive)", () => {
    const result = reconcileTasks(
      [task({ worktreePath: "/repos/myrepo-task", intendedBranch: "feature/task" })],
      [worktree({ path: "\\repos\\MYREPO-task", branch: "feature/task" })],
      repoRoot,
    );
    expect(result.tasks[0].worktreeExists).toBe(true);
    expect(result.tasks[0].changed).toBe(false);
    expect(result.orphans).toHaveLength(0);
  });

  describe("the intended branch", () => {
    it("is backfilled once from the recorded name, not from git", () => {
      // A task created before the field existed may already be sitting on a switched
      // branch, so taking git's answer would enshrine the wrong branch as intended.
      const result = reconcileTasks(
        [task({ worktreePath: "/repos/t", branchName: "feature/task" })],
        [worktree({ path: "/repos/t", branch: "LIVE_MultiMarket" })],
        repoRoot,
      );
      expect(result.tasks[0].task.intendedBranch).toBe("feature/task");
      expect(result.tasks[0].task.branchName).toBe("LIVE_MultiMarket");
      expect(result.tasks[0].changed).toBe(true);
    });

    it("is not overwritten once recorded, however the worktree moves", () => {
      // The whole point: git is the truth for what a worktree *is* on, and that must
      // not be allowed to redefine what the task is about.
      const result = reconcileTasks(
        [task({ worktreePath: "/repos/t", intendedBranch: "feature/task" })],
        [worktree({ path: "/repos/t", branch: "LIVE_MultiMarket" })],
        repoRoot,
      );
      expect(result.tasks[0].task.intendedBranch).toBe("feature/task");
    });
  });

  it("marks a task failed when its worktree is missing", () => {
    const result = reconcileTasks([task({})], [], repoRoot);
    expect(result.tasks[0].worktreeExists).toBe(false);
    expect(result.tasks[0].changed).toBe(true);
    expect(result.tasks[0].task.status).toBe("failed");
  });

  it("does not re-flag an already-failed task", () => {
    const result = reconcileTasks([task({ status: "failed" })], [], repoRoot);
    expect(result.tasks[0].changed).toBe(false);
  });

  it("refreshes a changed branch name from git", () => {
    const result = reconcileTasks(
      [task({ branchName: "feature/old" })],
      [worktree({ branch: "feature/new" })],
      repoRoot,
    );
    expect(result.tasks[0].changed).toBe(true);
    expect(result.tasks[0].task.branchName).toBe("feature/new");
  });

  it("reports unmatched worktrees as orphans, excluding the primary", () => {
    const result = reconcileTasks(
      [],
      [
        worktree({ path: "/repos/myrepo", branch: "main" }),
        worktree({ path: "/repos/myrepo-loose", branch: "loose" }),
      ],
      repoRoot,
    );
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].worktree.path).toBe("/repos/myrepo-loose");
  });
});
