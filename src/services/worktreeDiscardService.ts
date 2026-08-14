import { GitClient } from "../git/gitClient";
import {
  DiscardSelection,
  parsePorcelainChanges,
  selectDiscardable,
} from "../domain/worktreeDiscard";
import { Logger } from "../logging/logger";

/**
 * Restores the tracked paths a project declared to be local environment.
 *
 * The git half of `domain/worktreeDiscard.ts`: that module decides *what* may be
 * discarded and this one runs the command. Split for the usual reason — the decision is
 * where the rules live, and none of those rules can be covered with a git repository in
 * the way.
 *
 * `discardPaths` is a function rather than a value because it is read from the project's
 * `harness.json` at the repository root, and a task in flight must pick up a change to
 * it — the same reasoning as `stageModelSource`. Reading it per stage is also what keeps
 * a stale list from deleting a file somebody has since removed from the config.
 */
export class WorktreeDiscardService {
  constructor(
    private readonly git: GitClient,
    private readonly discardPaths: () => readonly string[],
    private readonly logger: Logger,
  ) {}

  /**
   * Restores whatever the project declared and this worktree currently has dirty.
   *
   * Returns undefined when there is nothing to say — no declared paths, or none of them
   * dirty — so a caller has no announcement to make and the common case stays silent.
   *
   * **A git failure is never fatal.** The discard exists to stop a check failing for the
   * wrong reason; letting it fail the stage on its own account would trade one spurious
   * failure for another. The check then runs against the tree as it stands and reports
   * honestly on it, which is the outcome the project had before this existed.
   */
  async discard(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<DiscardSelection | undefined> {
    const patterns = this.discardPaths();
    if (patterns.length === 0) return undefined;

    const status = await this.git.run(["status", "--porcelain"], {
      cwd: worktreePath,
      signal,
    });
    if (!status.ok) {
      this.logger.warn(
        `Could not read ${worktreePath} to discard local changes: ${status.error.message}`,
      );
      return undefined;
    }

    const selection = selectDiscardable(
      parsePorcelainChanges(status.value.stdout),
      patterns,
    );
    if (selection.discard.length === 0) {
      // Withheld paths still matter: they are declared, still dirty, and about to fail
      // the check anyway, so the caller announces them even though nothing was removed.
      return selection.withheld.length > 0 ? selection : undefined;
    }

    // `--` separates paths from revisions, so a declared path that happens to spell a
    // branch name restores the file rather than checking out the branch.
    const restored = await this.git.run(
      ["checkout", "--", ...selection.discard],
      { cwd: worktreePath, signal },
    );
    if (!restored.ok) {
      this.logger.warn(
        `Could not discard local changes in ${worktreePath}: ${restored.error.message}`,
      );
      // Nothing was restored, so nothing may be announced as restored. Reporting a
      // discard that did not happen is worse than reporting none: it sends someone
      // looking in the commit for a change that is still sitting in their tree.
      return selection.withheld.length > 0
        ? { discard: [], withheld: selection.withheld }
        : undefined;
    }

    return selection;
  }
}
