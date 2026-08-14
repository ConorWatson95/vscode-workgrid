import { TaskWorkspace } from "./taskWorkspace";
import { pathNamedInCommands } from "./claimEvidence";

/**
 * Who owns which worktree, and which ones a finished task may tidy away.
 *
 * A task has always known about its own worktree. Stages, though, create more of them
 * — a `promote/<ticket>-uat` tree to cherry-pick into, a live publish tree — and none of
 * those were recorded anywhere. Two costs followed, and both were paid on 2026-08-06:
 *
 * - **Nothing was cleaned up**, so nine worktrees accumulated, two of them holding a
 *   commit that had never reached DEV. The directories are the visible symptom; the
 *   stranded commits are the actual loss.
 * - **Nothing detected overlap.** A stage found `qube-publish-sm` parked on another
 *   ticket's promotion and could only report it in prose, because no record said whose
 *   it was.
 *
 * The distinction that makes cleanup safe is **created versus borrowed**. A task that
 * created `promote/NMGB-2792-uat` should remove it when done; a task that borrowed the
 * standing `qube-publish-sm` must leave it exactly where it found it, or the next publish
 * has nowhere to run. Recording only "worktrees this task used" would conflate the two
 * and delete shared infrastructure.
 *
 * Pure and vscode-free: every decision here is a function of recorded claims plus facts
 * git has already reported.
 */

/** A worktree a task has claimed, whether or not it created it. */
export interface WorktreeClaim {
  /** Normalised the same way as `TaskWorkspace.worktreePath` — see `normaliseWorktreePath`. */
  path: string;
  /** The branch it was claimed for. Not refreshed; git remains truth for what it is on now. */
  branch: string;
  claimedAt: string;
  /**
   * False when the task adopted an existing worktree rather than creating it.
   *
   * The whole basis of cleanup. Standing publish worktrees are long-lived and shared, so
   * removing one because a task happened to use it would break every later publish.
   */
  created: boolean;
  /** The stage that asked for it, so a refusal can say which part of the route cares. */
  stageId?: string;
}

/**
 * Normalises a worktree path for comparison: forward slashes, no trailing separator,
 * lower-cased.
 *
 * The same rules as `taskReconciliationService`'s reconciliation key, and for the same
 * reason — Windows hands back `C:\Dev\...` and `C:/Dev/...` interchangeably, so two
 * spellings of one directory would read as two worktrees and defeat both overlap
 * detection and cleanup.
 */
export function normaliseWorktreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** A worktree entry as git lists it, before or after a stage ran. */
export interface WorktreeEntry {
  path: string;
  branch?: string;
}

/** A worktree a stage took, and whether taking it meant making it. */
export interface ClaimCandidate {
  path: string;
  branch: string;
  created: boolean;
}

/**
 * What a stage took, from the worktree list before and after it ran.
 *
 * Two ways a stage takes one, and only the first was ever detected:
 *
 * - **It made it.** A path that was not there before — `promote/<ticket>-uat`, a fresh
 *   publish tree. Created, and therefore cleanup's business later.
 * - **It checked something out in a standing tree.** `qube-live-sm` was already there on
 *   `LIVE_SingleMarket`; the stage put `promote/NMGB-2534-rescura-uat` in it and pushed
 *   from there. Nothing appeared, so nothing was recorded, and the promotion branch
 *   belonged to no task at all — which is how a promotion tree came to sit in the orphan
 *   list as an unadopted stranger, produced by the harness itself.
 *
 * The second is a **borrowed** claim: the tree was not made here and must not be removed
 * here, or the next publish has nowhere to run. `created` is the whole basis on which
 * cleanup is allowed to act, so it is read from the observation rather than assumed —
 * before this, every claim in existence said `created: true` because that was the only
 * branch of code that wrote one.
 *
 * A tree that was already on the branch it ends on is not a claim. Every stage of every
 * route would otherwise claim every worktree in the repository merely by running.
 *
 * Appearing is necessary and **not sufficient**: the stage's own commands must name the
 * path, or the claim is an inference about the clock rather than about the agent. See
 * `claimEvidence.ts` for the hand-made worktree that was filed as a task's to delete.
 */
export function claimsFromSnapshots(
  before: readonly WorktreeEntry[],
  after: readonly WorktreeEntry[],
  commands: readonly string[],
): ClaimCandidate[] {
  const was = new Map(
    before.map((entry) => [normaliseWorktreePath(entry.path), entry.branch]),
  );
  const candidates: ClaimCandidate[] = [];

  for (const entry of after) {
    const key = normaliseWorktreePath(entry.path);
    // Both kinds need the evidence, not only the created ones: a branch switched by hand
    // in a standing tree during a stage is the same false attribution one level down.
    if (!pathNamedInCommands(entry.path, commands)) continue;
    if (!was.has(key)) {
      candidates.push({ path: entry.path, branch: entry.branch ?? "", created: true });
      continue;
    }
    // A detached tree reports no branch. Treated as no change rather than as a claim on
    // nothing: there is no branch to attribute, so a claim would name an empty one.
    if (!entry.branch) continue;
    if (was.get(key) === entry.branch) continue;
    candidates.push({ path: entry.path, branch: entry.branch, created: false });
  }

  return candidates;
}

/** What git currently reports about a path a task wants to claim. */
export interface WorktreeFacts {
  exists: boolean;
  /** Undefined when the worktree does not exist, or is detached. */
  branch?: string;
}

export type ClaimDecision =
  /** Nothing there; create it. */
  | { kind: "create" }
  /** Already present, on the wanted branch, and not held by anyone else. */
  | { kind: "reuse"; alreadyClaimed: boolean }
  /** Present but unusable, or held by another task. Never resolved by force. */
  | { kind: "conflict"; reason: string; heldBy?: string };

/**
 * Decides whether a task may take a worktree, without doing anything.
 *
 * Idempotent by construction: asking twice for the same path and branch yields `reuse`
 * the second time rather than a second worktree or an error, so a re-run stage does not
 * have to know whether the previous attempt got that far.
 *
 * Conflicts are reported, never resolved. Checking out the wanted branch over whatever is
 * there is precisely how one ticket's promotion ends up interleaved with another's.
 */
export function decideClaim(input: {
  taskId: string;
  path: string;
  branch: string;
  facts: WorktreeFacts;
  /** Every task, including the claimant — its own claims must not read as someone else's. */
  tasks: readonly TaskWorkspace[];
}): ClaimDecision {
  const wanted = normaliseWorktreePath(input.path);

  const holder = input.tasks.find(
    (task) =>
      task.id !== input.taskId &&
      (task.worktreeClaims ?? []).some(
        (claim) => normaliseWorktreePath(claim.path) === wanted,
      ),
  );
  if (holder) {
    return {
      kind: "conflict",
      reason: `already claimed by task "${holder.name}"`,
      heldBy: holder.id,
    };
  }

  // A task's own worktree is a claim even though it predates this record, otherwise
  // cleanup of one task could be offered the directory another task is working in.
  const occupant = input.tasks.find(
    (task) =>
      task.id !== input.taskId && normaliseWorktreePath(task.worktreePath) === wanted,
  );
  if (occupant) {
    return {
      kind: "conflict",
      reason: `it is the worktree of task "${occupant.name}"`,
      heldBy: occupant.id,
    };
  }

  const alreadyClaimed = (
    input.tasks.find((task) => task.id === input.taskId)?.worktreeClaims ?? []
  ).some((claim) => normaliseWorktreePath(claim.path) === wanted);

  if (!input.facts.exists) return { kind: "create" };

  if (!input.facts.branch) {
    return { kind: "conflict", reason: "the worktree is detached from any branch" };
  }
  if (input.facts.branch !== input.branch) {
    return {
      kind: "conflict",
      reason: `it is on "${input.facts.branch}", not "${input.branch}"`,
    };
  }
  return { kind: "reuse", alreadyClaimed };
}

/** Records a claim, replacing any existing one for the same path. */
export function recordClaim(task: TaskWorkspace, claim: WorktreeClaim): TaskWorkspace {
  const wanted = normaliseWorktreePath(claim.path);
  const kept = (task.worktreeClaims ?? []).filter(
    (existing) => normaliseWorktreePath(existing.path) !== wanted,
  );
  return { ...task, worktreeClaims: [...kept, claim] };
}

/** Git-reported state of a claimed worktree, gathered before cleanup. */
export interface CleanupFacts {
  path: string;
  exists: boolean;
  /** Uncommitted changes, INCLUDING untracked files. */
  dirty: boolean;
  /** Commits on its branch that no integration branch contains. */
  unmergedCommits: number;
}

export interface CleanupPlan {
  /** Safe to remove: created by this task, clean, and holding nothing unmerged. */
  remove: WorktreeClaim[];
  /** Left alone, each with the reason, so a skip is never silent. */
  retain: { claim: WorktreeClaim; reason: string }[];
}

/**
 * Decides which of a finished task's claimed worktrees may be removed.
 *
 * Deliberately conservative, because a worktree is where uncommitted work lives and this
 * runs without anyone watching. Removing the directory is recoverable — the branch and
 * its commits survive — but only if the work actually reached the branch, which is what
 * `dirty` and `unmergedCommits` establish.
 *
 * Branches are never deleted here. A worktree is a checkout and can be recreated from
 * the branch; deleting the branch discards the only copy of its commits, so it stays a
 * separate decision made by a human.
 */
export function planCleanup(
  task: TaskWorkspace,
  facts: readonly CleanupFacts[],
): CleanupPlan {
  const plan: CleanupPlan = { remove: [], retain: [] };
  const byPath = new Map(facts.map((f) => [normaliseWorktreePath(f.path), f]));

  for (const claim of task.worktreeClaims ?? []) {
    const key = normaliseWorktreePath(claim.path);

    // The task's own worktree is not cleanup's business: it is removed, if at all, by
    // deleting the task, and doing it here would strand the task pointing at nothing.
    if (key === normaliseWorktreePath(task.worktreePath)) {
      plan.retain.push({ claim, reason: "it is the task's own worktree" });
      continue;
    }
    if (!claim.created) {
      plan.retain.push({ claim, reason: "borrowed, not created by this task" });
      continue;
    }

    const fact = byPath.get(key);
    if (!fact || !fact.exists) {
      plan.retain.push({ claim, reason: "already gone" });
      continue;
    }
    if (fact.dirty) {
      plan.retain.push({ claim, reason: "uncommitted changes, including untracked files" });
      continue;
    }
    if (fact.unmergedCommits > 0) {
      plan.retain.push({
        claim,
        reason:
          `${fact.unmergedCommits} commit(s) not contained in any integration branch — ` +
          "merge them before this can be tidied away",
      });
      continue;
    }
    plan.remove.push(claim);
  }

  return plan;
}
