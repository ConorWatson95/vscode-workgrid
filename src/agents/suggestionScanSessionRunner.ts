import { TaskWorkspace } from "../domain/taskWorkspace";
import { SuggestionScanRunner } from "../services/suggestionScanService";

/**
 * Runs a suggestion scan as a stage session rooted at the repository.
 *
 * The part of `StageSessionRunner` a scan needs. Narrowed to an interface for the usual
 * reason — the scan service's tests need no CLI — and delegated to rather than
 * reimplemented, because everything a scan wants from a session already exists there:
 * MCP readiness abandoning the run *before* inference when a required server is
 * unavailable, a hard timeout so a hung CLI cannot stall the command, and the failure
 * logging that distinguishes "died having run no tools" from "died after forty".
 */
export interface ScanCapableRunner {
  run(
    task: TaskWorkspace,
    prompt: string,
    label: string,
    options?: { requiredMcpServers?: readonly string[] },
  ): Promise<{ ok: boolean; text: string; error?: string }>;
}

/**
 * The task id every scan session runs under.
 *
 * Fixed, and that is deliberate: `AgentSessionManager.create` stops the existing session
 * for an id, so two scans cannot run at once and a second one replaces the first rather
 * than competing with it for the same rate limit. It is also not a task id any real task
 * can hold, so nothing keyed by task — the gate inbox, live activities — can collide
 * with a genuine one.
 */
export const SCAN_TASK_ID = "suggestion-scan";

/**
 * Adapts a stage runner into a scan runner.
 *
 * The session is handed an **ephemeral task** whose worktree is the repository root.
 * That is the whole trick, and it is a description rather than a fiction: a scan is work
 * in the repository with no branch of its own, so the record that describes it is a task
 * whose worktree *is* the repository. It is never persisted, never reconciled and never
 * listed — `createScanTask` is the only place it exists.
 *
 * Rooted at the repository rather than a worktree because a scan reads a ticket board: a
 * task's branch has nothing to offer it, and running inside one would make what the scan
 * can see depend on which task happened to be checked out.
 */
export class SuggestionScanSessionRunner implements SuggestionScanRunner {
  constructor(
    private readonly runner: ScanCapableRunner,
    private readonly clock: { now(): string },
  ) {}

  async run(
    repositoryRoot: string,
    prompt: string,
    label: string,
    options?: { requiredMcpServers?: readonly string[] },
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    return this.runner.run(
      createScanTask(repositoryRoot, this.clock.now()),
      prompt,
      label,
      options,
    );
  }
}

/**
 * The ephemeral task a scan session runs as.
 *
 * `baseBranch` and `branchName` are left as the repository's own HEAD name because a
 * scan never diffs anything; nothing downstream of a scan reads them, and inventing a
 * branch would be the one part of this that *was* a fiction.
 */
export function createScanTask(repositoryRoot: string, at: string): TaskWorkspace {
  return {
    id: SCAN_TASK_ID,
    name: "Suggestion scan",
    repositoryRoot,
    worktreePath: repositoryRoot,
    branchName: "HEAD",
    baseBranch: "HEAD",
    status: "ready",
    createdAt: at,
    updatedAt: at,
  };
}
