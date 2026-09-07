import { GitStatusService } from "../git/gitStatusService";
import { TaskRepository } from "../persistence/taskRepository";
import { Logger } from "../logging/logger";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { CommitObservation, recordCommits } from "../domain/taskCommits";

/**
 * Keeps a task's record of its own commits up to date.
 *
 * The thin shell over `domain/taskCommits.ts`: one `rev-list`, one merge, one write —
 * and the write only when something is new, because stage boundaries observe constantly
 * and the state file is read-modify-write.
 *
 * Re-reads the task rather than trusting the one it was handed, for the reason every
 * write to that file does: the extension and a headless run both write it, and a stage
 * session takes minutes, so the copy the runner started with is routinely stale. Losing
 * a claim or a guidance note to a commit observation would be a poor trade.
 */
export class TaskCommitService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly status: GitStatusService,
    private readonly logger: Logger,
  ) {}

  /**
   * Observes what this task's branch carries that its base does not, and records it.
   *
   * Non-fatal throughout. This records evidence *for* later checks and nothing about
   * running a stage depends on it, so a git failure or a vanished task leaves the record
   * as it was — the direction `WorktreeDiscardService` and the unmeasured-wait rule both
   * choose. Failing a stage over a bookkeeping read would trade a degraded check for a
   * broken route.
   */
  async observe(task: TaskWorkspace, observation: CommitObservation): Promise<void> {
    const branch = task.intendedBranch ?? task.branchName;
    if (!branch || !task.baseBranch) return;

    const observed = await this.status.getUnpromotedCommits(
      task.worktreePath,
      branch,
      task.baseBranch,
    );
    if (!observed.ok) {
      this.logger.debug(
        `Could not read ${branch} against ${task.baseBranch} to record commits.`,
      );
      return;
    }

    const current = await this.repository.get(task.id);
    if (!current) return;

    const merged = recordCommits(current.commits, observed.value, observation);
    // Reference equality is the signal, which is what `recordCommits` returning the
    // original list is for: nothing new means no write, and no write means a stage
    // boundary costs one process launch rather than a rewrite of the whole state file.
    if (merged === current.commits) return;

    await this.repository.save({ ...current, commits: merged });
    const added = merged.length - (current.commits?.length ?? 0);
    this.logger.info(
      `Recorded ${added} new commit(s) for task "${current.name}" ` +
        `(${merged.length} in total).`,
    );
  }
}
