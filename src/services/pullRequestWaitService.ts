import { GitStatusService } from "../git/gitStatusService";
import { GitClient } from "../git/gitClient";
import { Logger } from "../logging/logger";
import { TaskWorkspace } from "../domain/taskWorkspace";
import {
  PullRequestWait,
  pullRequestState,
  isOutstanding,
} from "../domain/pullRequestWait";

/**
 * Answers whether the pull requests a route is waiting on have been merged.
 *
 * From git, with no hosting API and no token. *Merged* means the source branch's
 * commits are on the target, which is a local question once the remote refs are
 * current — so this works against Bitbucket, GitHub, GitLab and Azure DevOps without
 * knowing which is in use, and without the harness holding a credential. The stages
 * have no Bitbucket credentials by design, and their intents say so in capitals; it
 * would be a poor trade for the runtime to acquire some in order to ask a question git
 * can already answer.
 */
export class PullRequestWaitService {
  constructor(
    private readonly git: GitClient,
    private readonly status: GitStatusService,
    private readonly logger: Logger,
  ) {}

  /**
   * Which of these waits are now merged.
   *
   * Fetches once for the whole set rather than per wait: a live publish opens one per
   * target, and three fetches of the same remote to answer three questions about it is
   * three process launches for one answer.
   *
   * Non-fatal, and the failure direction is chosen. A wait this cannot resolve is
   * reported as **not** merged, so the route keeps holding and the operator clears it
   * by hand — where reporting merged on a failed read would advance a route onto a
   * target branch that does not have the work, which is the failure the whole state
   * exists to prevent.
   */
  async merged(
    task: TaskWorkspace,
    waits: readonly PullRequestWait[],
  ): Promise<{ url: string; merged: boolean }[]> {
    if (waits.length === 0) return [];

    // Remote-tracking refs are routinely behind, and every question below is about what
    // the remote has now. A failure is not fatal: the reads then use what this clone
    // already has, which can only under-report a merge.
    const fetched = await this.git.run(["fetch", "--quiet", "origin"], {
      cwd: task.worktreePath,
    });
    if (!fetched.ok) {
      this.logger.debug(
        `Could not fetch before resolving pull requests for "${task.name}"; ` +
          "using the refs already here, which may be behind.",
      );
    }

    const resolved: { url: string; merged: boolean }[] = [];
    for (const wait of waits) {
      if (!wait.source || !wait.target) {
        // Nothing local to ask. `pullRequestState` reports `unknowable` and the route
        // keeps holding until somebody says otherwise, rather than assuming a merge.
        resolved.push({ url: wait.url, merged: false });
        continue;
      }

      const commitsOnTarget = await this.status.isAncestor(
        task.worktreePath,
        wait.source,
        `origin/${wait.target}`,
      );
      const sourceOnRemote = await this.status.hasRemoteBranch(
        task.worktreePath,
        wait.source,
      );
      const state = pullRequestState(wait, { sourceOnRemote, commitsOnTarget });
      resolved.push({ url: wait.url, merged: !isOutstanding(state) });
      if (isOutstanding(state)) {
        this.logger.info(
          `Pull request for "${task.name}" is ${state}: ${wait.source} → ${wait.target}.`,
        );
      }
    }
    return resolved;
  }
}
