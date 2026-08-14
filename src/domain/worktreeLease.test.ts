import { describe, expect, it } from "vitest";
import {
  CleanupFacts,
  WorktreeClaim,
  claimsFromSnapshots,
  decideClaim,
  normaliseWorktreePath,
  planCleanup,
  recordClaim,
} from "./worktreeLease";
import { TaskWorkspace } from "./taskWorkspace";

const claim = (overrides: Partial<WorktreeClaim> = {}): WorktreeClaim => ({
  path: "C:/Dev/worktrees/promote-2792",
  branch: "promote/NMGB-2792-uat",
  claimedAt: "2026-08-06T10:00:00.000Z",
  created: true,
  ...overrides,
});

const task = (overrides: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  id: "t1",
  name: "Task one",
  repositoryRoot: "C:/Dev/app",
  worktreePath: "C:/Dev/worktrees/task-one",
  branchName: "fix/one",
  baseBranch: "DEV",
  status: "ready",
  createdAt: "2026-08-06T09:00:00.000Z",
  updatedAt: "2026-08-06T09:00:00.000Z",
  ...overrides,
});

const facts = (overrides: Partial<CleanupFacts> = {}): CleanupFacts => ({
  path: "C:/Dev/worktrees/promote-2792",
  exists: true,
  dirty: false,
  unmergedCommits: 0,
  ...overrides,
});

describe("normaliseWorktreePath", () => {
  it("treats the spellings Windows hands back as one path", () => {
    expect(normaliseWorktreePath("C:\\Dev\\Worktrees\\A\\")).toBe(
      normaliseWorktreePath("c:/dev/worktrees/a"),
    );
  });
});

describe("decideClaim", () => {
  const base = {
    taskId: "t1",
    path: "C:/Dev/worktrees/publish-sm",
    branch: "LIVE_SingleMarket",
  };

  it("creates when nothing is there", () => {
    const decision = decideClaim({ ...base, facts: { exists: false }, tasks: [task()] });
    expect(decision.kind).toBe("create");
  });

  it("reuses an existing worktree already on the wanted branch", () => {
    // Idempotency: a re-run stage must not need to know whether the last attempt got here.
    const decision = decideClaim({
      ...base,
      facts: { exists: true, branch: "LIVE_SingleMarket" },
      tasks: [task()],
    });
    expect(decision).toEqual({ kind: "reuse", alreadyClaimed: false });
  });

  it("reports its own prior claim as already claimed", () => {
    const decision = decideClaim({
      ...base,
      facts: { exists: true, branch: "LIVE_SingleMarket" },
      tasks: [
        task({ worktreeClaims: [claim({ path: base.path, branch: base.branch })] }),
      ],
    });
    expect(decision).toEqual({ kind: "reuse", alreadyClaimed: true });
  });

  it("refuses a worktree on a different branch rather than checking out over it", () => {
    // The real incident: qube-publish-sm parked on another ticket's promotion. Forcing
    // the wanted branch is how two promotions interleave on one branch.
    const decision = decideClaim({
      ...base,
      facts: { exists: true, branch: "promote/NMGB-2797-LIVE_SingleMarket" },
      tasks: [task()],
    });
    expect(decision.kind).toBe("conflict");
    expect(decision).toMatchObject({ reason: expect.stringContaining("NMGB-2797") });
  });

  it("refuses a detached worktree", () => {
    const decision = decideClaim({
      ...base,
      facts: { exists: true },
      tasks: [task()],
    });
    expect(decision).toMatchObject({ kind: "conflict", reason: expect.stringContaining("detached") });
  });

  it("refuses a worktree another task has claimed, naming it", () => {
    const decision = decideClaim({
      ...base,
      facts: { exists: true, branch: "LIVE_SingleMarket" },
      tasks: [
        task(),
        task({
          id: "t2",
          name: "Task two",
          worktreeClaims: [claim({ path: base.path })],
        }),
      ],
    });
    expect(decision).toMatchObject({ kind: "conflict", heldBy: "t2" });
    expect((decision as { reason: string }).reason).toContain("Task two");
  });

  it("refuses another task's own worktree, which predates claims", () => {
    const decision = decideClaim({
      ...base,
      facts: { exists: true, branch: "LIVE_SingleMarket" },
      tasks: [task(), task({ id: "t2", name: "Task two", worktreePath: base.path })],
    });
    expect(decision).toMatchObject({ kind: "conflict", heldBy: "t2" });
  });

  it("does not treat the claimant's own worktree as a conflict", () => {
    const decision = decideClaim({
      ...base,
      path: "C:/Dev/worktrees/task-one",
      facts: { exists: true, branch: "LIVE_SingleMarket" },
      tasks: [task()],
    });
    expect(decision.kind).toBe("reuse");
  });
});

describe("recordClaim", () => {
  it("replaces an existing claim for the same path rather than duplicating it", () => {
    const first = recordClaim(task(), claim({ claimedAt: "2026-08-06T10:00:00.000Z" }));
    const second = recordClaim(first, claim({ claimedAt: "2026-08-06T11:00:00.000Z" }));
    expect(second.worktreeClaims).toHaveLength(1);
    expect(second.worktreeClaims![0].claimedAt).toBe("2026-08-06T11:00:00.000Z");
  });

  it("does not mutate its input", () => {
    const original = task();
    recordClaim(original, claim());
    expect(original.worktreeClaims).toBeUndefined();
  });
});

describe("planCleanup", () => {
  it("removes a clean, fully merged worktree the task created", () => {
    const plan = planCleanup(task({ worktreeClaims: [claim()] }), [facts()]);
    expect(plan.remove).toHaveLength(1);
    expect(plan.retain).toHaveLength(0);
  });

  it("never removes a borrowed worktree", () => {
    // The standing publish worktrees are shared. Removing one because a task used it
    // breaks every later publish.
    const plan = planCleanup(task({ worktreeClaims: [claim({ created: false })] }), [facts()]);
    expect(plan.remove).toHaveLength(0);
    expect(plan.retain[0].reason).toContain("borrowed");
  });

  it("retains a worktree with uncommitted work", () => {
    const plan = planCleanup(task({ worktreeClaims: [claim()] }), [facts({ dirty: true })]);
    expect(plan.remove).toHaveLength(0);
    expect(plan.retain[0].reason).toContain("untracked");
  });

  it("retains a worktree holding unmerged commits, and says how many", () => {
    // The actual loss on 2026-08-06: two done tasks each holding one commit that had
    // never reached DEV. The directory is the symptom; this is the cost.
    const plan = planCleanup(task({ worktreeClaims: [claim()] }), [
      facts({ unmergedCommits: 2 }),
    ]);
    expect(plan.remove).toHaveLength(0);
    expect(plan.retain[0].reason).toContain("2 commit(s)");
  });

  it("never removes the task's own worktree", () => {
    const plan = planCleanup(
      task({ worktreeClaims: [claim({ path: "C:/Dev/worktrees/task-one" })] }),
      [facts({ path: "C:/Dev/worktrees/task-one" })],
    );
    expect(plan.remove).toHaveLength(0);
    expect(plan.retain[0].reason).toContain("task's own worktree");
  });

  it("retains rather than fails when a worktree is already gone", () => {
    const plan = planCleanup(task({ worktreeClaims: [claim()] }), [facts({ exists: false })]);
    expect(plan.remove).toHaveLength(0);
    expect(plan.retain[0].reason).toBe("already gone");
  });

  it("retains when git reported nothing about a claimed path", () => {
    const plan = planCleanup(task({ worktreeClaims: [claim()] }), []);
    expect(plan.remove).toHaveLength(0);
  });

  it("handles a task with no claims", () => {
    const plan = planCleanup(task(), []);
    expect(plan).toEqual({ remove: [], retain: [] });
  });
});

describe("claimsFromSnapshots", () => {
  const MADE_PROMOTE = [
    "git worktree add C:/Dev/promote-2792 -b promote/NMGB-2792-uat origin/UAT",
  ];

  it("claims a worktree that appeared, as created", () => {
    expect(
      claimsFromSnapshots(
        [{ path: "C:/Dev/app-t1", branch: "feature/x" }],
        [
          { path: "C:/Dev/app-t1", branch: "feature/x" },
          { path: "C:/Dev/promote-2792", branch: "promote/NMGB-2792-uat" },
        ],
        MADE_PROMOTE,
      ),
    ).toEqual([
      { path: "C:/Dev/promote-2792", branch: "promote/NMGB-2792-uat", created: true },
    ]);
  });

  // The case that recorded nothing at all. A promotion stage checks its branch out in
  // the standing publish tree and pushes from there; no directory appears, so the
  // branch it just created belonged to no task and showed up as an orphan.
  it("claims a standing worktree that changed branch, as borrowed", () => {
    expect(
      claimsFromSnapshots(
        [{ path: "C:/Dev/qube-live-sm", branch: "LIVE_SingleMarket" }],
        [{ path: "C:/Dev/qube-live-sm", branch: "promote/NMGB-2534-rescura-uat" }],
        ["git -C C:/Dev/qube-live-sm checkout promote/NMGB-2534-rescura-uat"],
      ),
    ).toEqual([
      {
        path: "C:/Dev/qube-live-sm",
        branch: "promote/NMGB-2534-rescura-uat",
        created: false,
      },
    ]);
  });

  // The 14 Aug 2026 incident. The operator made this worktree by hand for unrelated work
  // while a promotion stage happened to be running; it was filed as that task's, in the
  // class cleanup may delete. Appearing during a window says nothing about who acted.
  it("claims nothing the stage's own commands do not name", () => {
    expect(
      claimsFromSnapshots(
        [{ path: "C:/Dev/app-t1", branch: "feature/x" }],
        [
          { path: "C:/Dev/app-t1", branch: "feature/x" },
          { path: "C:/Dev/qube-live-sm", branch: "LIVE_SingleMarket" },
        ],
        ["git status --porcelain", "git log origin/DEV --oneline -n 5"],
      ),
    ).toEqual([]);
  });

  it("claims nothing when the stage recorded no commands at all", () => {
    expect(
      claimsFromSnapshots(
        [],
        [{ path: "C:/Dev/promote-2792", branch: "promote/NMGB-2792-uat" }],
        [],
      ),
    ).toEqual([]);
  });

  // A command spells a path however its own shell does. A claim lost to a spelling
  // difference is a real worktree attributed to nobody, so the last segment decides —
  // safe only because appearing in this repository during this stage is also required.
  it("matches a path a command spelt differently", () => {
    const after = [{ path: "C:/Dev/worktrees/promote-2792", branch: "promote/x" }];
    for (const command of [
      "git worktree add /c/Dev/worktrees/promote-2792 promote/x",
      "cd ..\\PROMOTE-2792 && git push",
      "git -C ../promote-2792 status",
    ]) {
      expect(claimsFromSnapshots([], after, [command])).toHaveLength(1);
    }
  });

  it("claims nothing when nothing moved", () => {
    const listed = [
      { path: "C:/Dev/app-t1", branch: "feature/x" },
      { path: "C:/Dev/qube-live-sm", branch: "LIVE_SingleMarket" },
    ];
    expect(claimsFromSnapshots(listed, listed, ["git -C C:/Dev/qube-live-sm log"])).toEqual(
      [],
    );
  });

  it("ignores a worktree that went detached rather than claiming an empty branch", () => {
    expect(
      claimsFromSnapshots(
        [{ path: "C:/Dev/qube-live-sm", branch: "LIVE_SingleMarket" }],
        [{ path: "C:/Dev/qube-live-sm" }],
        ["git -C C:/Dev/qube-live-sm checkout --detach"],
      ),
    ).toEqual([]);
  });

  it("matches paths across separators and case", () => {
    expect(
      claimsFromSnapshots(
        [{ path: "C:\\Dev\\Qube-Live-SM", branch: "LIVE_SingleMarket" }],
        [{ path: "C:/Dev/qube-live-sm", branch: "LIVE_SingleMarket" }],
        ["git -C C:/Dev/qube-live-sm status"],
      ),
    ).toEqual([]);
  });

  it("does not care that a worktree disappeared", () => {
    expect(
      claimsFromSnapshots(
        [{ path: "C:/Dev/gone", branch: "promote/x" }],
        [],
        ["git worktree remove C:/Dev/gone"],
      ),
    ).toEqual([]);
  });
});
