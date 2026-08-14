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

describe("claimed worktrees", () => {
  const REPO = "C:/repos/app";
  const taskAt = (path: string, claims: string[] = []) =>
    ({
      id: "t1",
      name: "Publish",
      worktreePath: path,
      branchName: "feature/x",
      repositoryRoot: REPO,
      worktreeClaims: claims.map((claim) => ({
        path: claim,
        branch: "promote/x",
        claimedAt: "2026-08-07T09:00:00Z",
        created: true,
      })),
    }) as unknown as TaskWorkspace;

  const wt = (path: string, branch = "promote/x") =>
    ({ path, branch }) as GitWorktree;

  // A stage creating a promote/* tree is a task accounting for it. Before claims
  // existed these appeared as unadopted strangers — the harness filling its own
  // orphan list, which trains a reader to ignore it.
  it("does not report a worktree a task has claimed as an orphan", () => {
    const result = reconcileTasks(
      [taskAt("C:/repos/app-t1", ["C:/repos/promote-uat"])],
      [wt("C:/repos/app-t1"), wt("C:/repos/promote-uat")],
      REPO,
    );
    expect(result.orphans).toEqual([]);
  });

  it("still reports a worktree nobody claimed", () => {
    const result = reconcileTasks(
      [taskAt("C:/repos/app-t1", ["C:/repos/promote-uat"])],
      [
        wt("C:/repos/app-t1"),
        wt("C:/repos/promote-uat"),
        wt("C:/repos/stray", "someone/else"),
      ],
      REPO,
    );
    expect(result.orphans.map((o) => o.worktree.path)).toEqual(["C:/repos/stray"]);
  });

  // A promotion tree is not the same directory twice: the one for NMGB-2534 was made,
  // pushed and removed, and a later stage remade it elsewhere. The branch is what the
  // claim is really about, and it outlives any particular checkout of it.
  it("does not report a claimed branch checked out at another path as an orphan", () => {
    const result = reconcileTasks(
      [taskAt("C:/repos/app-t1", ["C:/repos/promote-uat"])],
      [wt("C:/repos/app-t1"), wt("C:/repos/promote-uat-2", "promote/x")],
      REPO,
    );
    expect(result.orphans).toEqual([]);
  });

  // Windows hands back both spellings of the same directory.
  it("matches a claim whose path is spelt with other separators or case", () => {
    const result = reconcileTasks(
      [taskAt("C:/repos/app-t1", ["C:\\Repos\\Promote-UAT"])],
      [wt("C:/repos/app-t1"), wt("C:/repos/promote-uat")],
      REPO,
    );
    expect(result.orphans).toEqual([]);
  });

  // A task whose own worktree vanished is marked failed, not deleted — the trees it
  // claimed stay its responsibility until someone says otherwise.
  it("honours claims of a task whose own worktree is missing", () => {
    const result = reconcileTasks(
      [taskAt("C:/repos/app-gone", ["C:/repos/promote-uat"])],
      [wt("C:/repos/promote-uat")],
      REPO,
    );
    expect(result.orphans).toEqual([]);
    expect(result.tasks[0].worktreeExists).toBe(false);
  });
});
