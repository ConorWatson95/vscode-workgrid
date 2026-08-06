import { describe, expect, it } from "vitest";
import { WorktreeClaimService, WorktreeGit } from "./worktreeClaimService";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Logger } from "../logging/logger";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const AT = "2026-08-06T12:00:00.000Z";

function task(overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id: "t1",
    name: "NMGB-2792",
    repositoryRoot: "C:/repos/app",
    worktreePath: "C:/repos/app-t1",
    branchName: "feature/NMGB-2792",
    baseBranch: "DEV",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** A git port whose answers are supplied per call, and which records removals. */
function fakeGit(
  options: {
    lists?: { path: string; branch?: string }[][];
    dirty?: Record<string, boolean | undefined>;
    unmerged?: Record<string, number | undefined>;
    refuse?: Record<string, string>;
  } = {},
): WorktreeGit & { removed: string[] } {
  const lists = [...(options.lists ?? [])];
  const removed: string[] = [];
  return {
    removed,
    // Each call consumes the next snapshot, so before-and-after can differ. The last
    // one repeats, which is what a single-answer test wants.
    async list() {
      return lists.length > 1 ? lists.shift() : lists[0];
    },
    async isDirty(path) {
      return options.dirty?.[path];
    },
    async countUnmerged(path) {
      return options.unmerged?.[path];
    },
    async remove(_root, path) {
      const problem = options.refuse?.[path];
      if (problem) return problem;
      removed.push(path);
      return undefined;
    },
  };
}

describe("recordAppeared", () => {
  it("claims a worktree that appeared while a stage ran, as created", () => {
    // Created, because it was not there before the stage: that is the whole basis on
    // which cleanup is later allowed to remove it.
    const git = fakeGit({
      lists: [
        [{ path: "C:/repos/app-t1", branch: "feature/NMGB-2792" }],
        [
          { path: "C:/repos/app-t1", branch: "feature/NMGB-2792" },
          { path: "C:/repos/promote-2792-uat", branch: "promote/NMGB-2792-uat" },
        ],
      ],
    });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);

    return (async () => {
      await repo.save(task());
      const before = await service.snapshot("C:/repos/app");
      const outcome = await service.recordAppeared("t1", before, {
        stageId: "promote-uat",
        at: AT,
      });

      expect(outcome.conflicts).toEqual([]);
      expect(outcome.claimed).toEqual([
        {
          path: "C:/repos/promote-2792-uat",
          branch: "promote/NMGB-2792-uat",
          claimedAt: AT,
          created: true,
          stageId: "promote-uat",
        },
      ]);
      const saved = await repo.get("t1");
      expect(saved?.worktreeClaims).toHaveLength(1);
    })();
  });

  it("claims nothing when the stage created nothing", async () => {
    const listed = [{ path: "C:/repos/app-t1", branch: "feature/NMGB-2792" }];
    const git = fakeGit({ lists: [listed] });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);
    await repo.save(task());

    const before = await service.snapshot("C:/repos/app");
    const outcome = await service.recordAppeared("t1", before, { stageId: "s", at: AT });

    expect(outcome).toEqual({ claimed: [], conflicts: [] });
    expect((await repo.get("t1"))?.worktreeClaims).toBeUndefined();
  });

  it("reports a conflict instead of claiming a worktree another task holds", async () => {
    const git = fakeGit({
      lists: [
        [{ path: "C:/repos/app-t1" }],
        [{ path: "C:/repos/app-t1" }, { path: "C:/repos/qube-publish-sm", branch: "live" }],
      ],
    });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);
    await repo.save(task());
    await repo.save(
      task({
        id: "t2",
        name: "NMGB-2801",
        worktreePath: "C:/repos/app-t2",
        worktreeClaims: [
          {
            path: "C:/repos/qube-publish-sm",
            branch: "live",
            claimedAt: AT,
            created: false,
          },
        ],
      }),
    );

    const before = await service.snapshot("C:/repos/app");
    const outcome = await service.recordAppeared("t1", before, { stageId: "publish", at: AT });

    expect(outcome.claimed).toEqual([]);
    expect(outcome.conflicts[0].reason).toContain("NMGB-2801");
    expect((await repo.get("t1"))?.worktreeClaims).toBeUndefined();
  });

  it("does nothing without a snapshot, so a runner with no git behaves as before", async () => {
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(fakeGit(), repo, logger);
    await repo.save(task());
    expect(await service.recordAppeared("t1", undefined, { stageId: "s", at: AT })).toEqual({
      claimed: [],
      conflicts: [],
    });
  });
});

describe("planFor and apply", () => {
  const claimed = (overrides: Partial<TaskWorkspace> = {}) =>
    task({
      worktreeClaims: [
        {
          path: "C:/repos/promote-2792-uat",
          branch: "promote/NMGB-2792-uat",
          claimedAt: AT,
          created: true,
        },
      ],
      ...overrides,
    });

  const present = [
    { path: "C:/repos/app-t1" },
    { path: "C:/repos/promote-2792-uat", branch: "promote/NMGB-2792-uat" },
  ];

  it("removes a clean, merged worktree the task created, and drops its claim", async () => {
    const git = fakeGit({
      lists: [present],
      dirty: { "C:/repos/promote-2792-uat": false },
      unmerged: { "C:/repos/promote-2792-uat": 0 },
    });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);
    const subject = claimed();
    await repo.save(subject);

    const plan = await service.planFor(subject);
    expect(plan.remove).toHaveLength(1);

    const result = await service.apply(subject, plan, AT);
    expect(result).toEqual({ removed: ["C:/repos/promote-2792-uat"], failed: [] });
    expect((await repo.get("t1"))?.worktreeClaims).toEqual([]);
  });

  it("retains a worktree git could not be read for, rather than assuming it is safe", async () => {
    // Unreadable has to count as unsafe: this runs unattended, and removing a worktree
    // nobody could inspect is how the only copy of a commit is lost.
    const git = fakeGit({ lists: [present] });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);
    const subject = claimed();
    await repo.save(subject);

    const plan = await service.planFor(subject);
    expect(plan.remove).toEqual([]);
    expect(plan.retain[0].reason).toContain("uncommitted");
  });

  it("retains a worktree holding commits the base branch does not have", async () => {
    const git = fakeGit({
      lists: [present],
      dirty: { "C:/repos/promote-2792-uat": false },
      unmerged: { "C:/repos/promote-2792-uat": 2 },
    });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);
    const subject = claimed();
    await repo.save(subject);

    const plan = await service.planFor(subject);
    expect(plan.remove).toEqual([]);
    expect(plan.retain[0].reason).toContain("2 commit(s)");
  });

  it("keeps the claim when the removal itself refused", async () => {
    // A claim dropped for a worktree still on disk would make it an untracked
    // directory again, which is the state this mechanism exists to end.
    const git = fakeGit({
      lists: [present],
      dirty: { "C:/repos/promote-2792-uat": false },
      unmerged: { "C:/repos/promote-2792-uat": 0 },
      refuse: { "C:/repos/promote-2792-uat": "worktree is locked" },
    });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);
    const subject = claimed();
    await repo.save(subject);

    const result = await service.apply(subject, await service.planFor(subject), AT);
    expect(result.removed).toEqual([]);
    expect(result.failed[0].reason).toBe("worktree is locked");
    expect((await repo.get("t1"))?.worktreeClaims).toHaveLength(1);
  });

  it("never offers a borrowed worktree for removal", async () => {
    // The standing publish trees are shared: removing one because a task used it
    // breaks every later publish.
    const git = fakeGit({
      lists: [[{ path: "C:/repos/qube-publish-sm", branch: "live" }]],
      dirty: { "C:/repos/qube-publish-sm": false },
      unmerged: { "C:/repos/qube-publish-sm": 0 },
    });
    const repo = new InMemoryTaskRepository();
    const service = new WorktreeClaimService(git, repo, logger);
    const subject = task({
      worktreeClaims: [
        { path: "C:/repos/qube-publish-sm", branch: "live", claimedAt: AT, created: false },
      ],
    });
    await repo.save(subject);

    const plan = await service.planFor(subject);
    expect(plan.remove).toEqual([]);
    expect(plan.retain[0].reason).toContain("borrowed");
  });

  it("plans nothing for a task with no claims", async () => {
    const service = new WorktreeClaimService(fakeGit(), new InMemoryTaskRepository(), logger);
    expect(await service.planFor(task())).toEqual({ remove: [], retain: [] });
  });
});
