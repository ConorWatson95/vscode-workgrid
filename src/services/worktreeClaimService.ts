import { Logger } from "../logging/logger";
import { TaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import {
  CleanupFacts,
  WorktreeClaim,
  claimsFromSnapshots,
  decideClaim,
  normaliseWorktreePath,
  planCleanup,
  recordClaim,
} from "../domain/worktreeLease";

/**
 * Keeps the record of which worktrees a task holds, and tidies away the ones it made.
 *
 * `domain/worktreeLease.ts` decides everything; this only gathers the facts git already
 * knows and applies the decision. The split is the usual one — the decisions are pure
 * and tested, and this is a thin shell over a narrow git port, so its own tests need no
 * repository on disk.
 *
 * **Claims are detected, not requested.** The worktrees this exists to track are made
 * by an agent inside a stage — `git worktree add promote/<ticket>-uat` — not by the
 * extension, so there is no call to hook. What the harness can do is compare the worktree
 * list before and after such a stage against the commands the stage actually ran: a path
 * that appeared is created, a path already there on a new branch is borrowed, and either
 * way one of the stage's own commands has to name it. That last requirement is not
 * belt-and-braces — see `claimEvidence.ts`. Without it the detection is about the clock,
 * and it filed a worktree the operator made by hand as a task's to delete.
 */

/** The git operations claim-keeping needs, and nothing else. */
export interface WorktreeGit {
  /** Every worktree of the repository, or undefined if git could not be read. */
  list(
    repositoryRoot: string,
  ): Promise<{ path: string; branch?: string }[] | undefined>;
  /** Uncommitted changes, including untracked files. Undefined when unreadable. */
  isDirty(worktreePath: string): Promise<boolean | undefined>;
  /**
   * Commits on the worktree's HEAD that `baseBranch` does not contain.
   *
   * Undefined when it cannot be counted — treated as "there might be some", because
   * the alternative is removing a worktree whose commits exist nowhere else.
   */
  countUnmerged(
    worktreePath: string,
    baseBranch: string,
  ): Promise<number | undefined>;
  /** Removes a worktree, returning a message if it refused. */
  remove(repositoryRoot: string, worktreePath: string): Promise<string | undefined>;
}

/** Worktree paths present before a stage ran. */
export type WorktreeSnapshot = { path: string; branch?: string }[];

export interface ClaimOutcome {
  claimed: WorktreeClaim[];
  /**
   * Worktrees that appeared but belong to someone else.
   *
   * Reported so the stage can be held. Previously the only way this surfaced was an
   * agent reading `git worktree list` and saying so in prose — which is how one
   * ticket's promotion tree came to be occupied by another's.
   */
  conflicts: { path: string; reason: string }[];
}

export class WorktreeClaimService {
  constructor(
    private readonly git: WorktreeGit,
    private readonly repository: TaskRepository,
    private readonly logger: Logger,
  ) {}

  /** The worktrees a repository has now, to be compared after a stage runs. */
  async snapshot(repositoryRoot: string): Promise<WorktreeSnapshot | undefined> {
    return await this.git.list(repositoryRoot);
  }

  /**
   * Records every worktree a stage took — made, or checked something else out in — and
   * reports any that another task already holds.
   *
   * Saves through the repository rather than returning a task, because the caller has
   * usually just saved the pipeline and a second in-memory copy would race it: the
   * state file is read-modify-write, and whichever copy was written last would win.
   */
  async recordStageClaims(
    taskId: string,
    before: WorktreeSnapshot | undefined,
    options: { stageId: string; at: string; commands: readonly string[] },
  ): Promise<ClaimOutcome> {
    const empty: ClaimOutcome = { claimed: [], conflicts: [] };
    if (!before) return empty;

    const task = await this.repository.get(taskId);
    if (!task) return empty;

    const after = await this.git.list(task.repositoryRoot);
    if (!after) return empty;

    // The commands come from the reply the caller is holding, not from the pipeline.
    // Every early exit — a question, a stop, a held permission — *reverts* the subtask,
    // which discards its activity, and those are exactly the paths a promotion stage
    // leaves by. Read from the pipeline, the evidence would be gone precisely when it
    // was needed. A stage that recorded no commands claims nothing, which is right:
    // there is nothing to say it touched a worktree.
    const appeared = claimsFromSnapshots(before, after, options.commands);
    if (appeared.length === 0) return empty;

    // Only this repository's tasks: a claim is a path in one repo's worktree list, and a
    // clone elsewhere on the machine has no bearing on who holds it.
    const tasks = await this.repository.getByRepository(task.repositoryRoot);
    const outcome: ClaimOutcome = { claimed: [], conflicts: [] };
    let updated = task;

    for (const entry of appeared) {
      const decision = decideClaim({
        taskId,
        path: entry.path,
        branch: entry.branch,
        facts: { exists: true, branch: entry.branch || undefined },
        tasks,
      });
      // A conflict is reported and never forced. Checking out the branch we wanted over
      // whatever is there is exactly how two promotions interleave.
      if (decision.kind === "conflict") {
        outcome.conflicts.push({ path: entry.path, reason: decision.reason });
        this.logger.warn(
          `Harness [${task.name}] "${entry.path}" appeared during "${options.stageId}" ` +
            `but ${decision.reason}.`,
        );
        continue;
      }

      const claim: WorktreeClaim = {
        path: entry.path,
        branch: entry.branch,
        claimedAt: options.at,
        // Read from the observation, never assumed. `created` decides whether cleanup
        // may remove the directory, and it used to be hardcoded true because appearing
        // was the only thing detected — so a standing publish tree the stage merely
        // checked a promotion branch out in was recorded as this task's to delete.
        created: entry.created,
        stageId: options.stageId,
      };
      updated = recordClaim(updated, claim);
      outcome.claimed.push(claim);
    }

    if (outcome.claimed.length > 0) {
      await this.repository.save({ ...updated, updatedAt: options.at });
      this.logger.info(
        `Harness [${task.name}] claimed ${outcome.claimed.length} worktree(s) during ` +
          `"${options.stageId}": ` +
          outcome.claimed
            .map((c) => `${c.path} (${c.branch}, ${c.created ? "created" : "borrowed"})`)
            .join(", ") +
          ".",
      );
    }
    return outcome;
  }

  /**
   * What a finished task's claimed worktrees may have done to them, without doing any
   * of it.
   *
   * Separated from the removal so the caller can ask before deleting. A worktree is
   * where uncommitted work lives, and `planCleanup` being conservative is not the same
   * as a human having agreed.
   */
  async planFor(task: TaskWorkspace): Promise<ReturnType<typeof planCleanup>> {
    const claims = task.worktreeClaims ?? [];
    if (claims.length === 0) return { remove: [], retain: [] };

    const listed = (await this.git.list(task.repositoryRoot)) ?? [];
    const present = new Set(listed.map((entry) => normaliseWorktreePath(entry.path)));

    const facts: CleanupFacts[] = [];
    for (const claim of claims) {
      const exists = present.has(normaliseWorktreePath(claim.path));
      if (!exists) {
        facts.push({ path: claim.path, exists: false, dirty: false, unmergedCommits: 0 });
        continue;
      }
      const dirty = await this.git.isDirty(claim.path);
      const unmerged = await this.git.countUnmerged(claim.path, task.baseBranch);
      facts.push({
        path: claim.path,
        exists: true,
        // Unreadable counts as unsafe in both cases. Removing a worktree we could not
        // inspect is how the only copy of a commit is lost, and this runs unattended.
        dirty: dirty ?? true,
        unmergedCommits: unmerged ?? 1,
      });
    }

    return planCleanup(task, facts);
  }

  /**
   * Removes the worktrees a plan cleared, dropping their claims as they go.
   *
   * A claim is dropped only when its worktree is actually gone. A claim removed for a
   * worktree still on disk would be an untracked directory again, which is the state
   * this whole mechanism exists to end.
   */
  async apply(
    task: TaskWorkspace,
    plan: ReturnType<typeof planCleanup>,
    at: string,
  ): Promise<{ removed: string[]; failed: { path: string; reason: string }[] }> {
    const removed: string[] = [];
    const failed: { path: string; reason: string }[] = [];

    for (const claim of plan.remove) {
      const problem = await this.git.remove(task.repositoryRoot, claim.path);
      if (problem) {
        failed.push({ path: claim.path, reason: problem });
        this.logger.warn(
          `Harness [${task.name}] could not remove "${claim.path}": ${problem}`,
        );
        continue;
      }
      removed.push(claim.path);
    }
    if (removed.length === 0) return { removed, failed };

    // Re-read: the caller may have saved the task since, and the state file is
    // read-modify-write.
    const current = (await this.repository.get(task.id)) ?? task;
    const gone = new Set(removed.map((path) => normaliseWorktreePath(path)));
    await this.repository.save({
      ...current,
      worktreeClaims: (current.worktreeClaims ?? []).filter(
        (claim) => !gone.has(normaliseWorktreePath(claim.path)),
      ),
      updatedAt: at,
    });
    this.logger.info(
      `Harness [${task.name}] removed ${removed.length} worktree(s) it created: ` +
        `${removed.join(", ")}. Branches were left alone.`,
    );
    return { removed, failed };
  }
}
