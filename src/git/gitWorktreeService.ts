import { GitClient, GitError } from "./gitClient";
import { parseWorktreeList } from "./worktreeParser";
import { GitWorktree, CreateWorktreeOptions, RemoveWorktreeOptions } from "./types";
import { GitStatusService } from "./gitStatusService";
import { Result, ok, err } from "../utilities/result";

export type WorktreeError =
  | { kind: "git"; error: GitError }
  | { kind: "validation"; message: string }
  | { kind: "dirty"; message: string };

function gitErr(error: GitError): Result<never, WorktreeError> {
  return err({ kind: "git", error });
}

export class GitWorktreeService {
  constructor(
    private readonly git: GitClient,
    private readonly status: GitStatusService,
  ) {}

  /** Resolves the repository root (top-level worktree dir) for a path. */
  async getRepositoryRoot(
    fsPath: string,
    signal?: AbortSignal,
  ): Promise<Result<string, WorktreeError>> {
    // Confirm we are inside a working tree first.
    const check = await this.git.run(["rev-parse", "--is-inside-work-tree"], {
      cwd: fsPath,
      signal,
    });
    if (!check.ok) return gitErr(check.error);

    // Resolve the *main* worktree so tasks are always keyed by the same root,
    // even when we are invoked from inside a linked worktree (where
    // `rev-parse --show-toplevel` would return the linked worktree's own path).
    // `git worktree list` always reports the main worktree first.
    const list = await this.git.run(["worktree", "list", "--porcelain"], {
      cwd: fsPath,
      signal,
    });
    if (!list.ok) return gitErr(list.error);
    const worktrees = parseWorktreeList(list.value.stdout);
    const main = worktrees.find((w) => !w.bare) ?? worktrees[0];
    if (!main) {
      // No worktrees reported (e.g. bare repo with none) — fall back to toplevel.
      const top = await this.git.run(["rev-parse", "--show-toplevel"], {
        cwd: fsPath,
        signal,
      });
      if (!top.ok) return gitErr(top.error);
      return ok(top.value.stdout.trim());
    }
    return ok(main.path);
  }

  async listWorktrees(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<Result<GitWorktree[], WorktreeError>> {
    const result = await this.git.run(["worktree", "list", "--porcelain"], {
      cwd: repositoryRoot,
      signal,
    });
    if (!result.ok) return gitErr(result.error);
    return ok(parseWorktreeList(result.value.stdout));
  }

  async createWorktree(
    repositoryRoot: string,
    options: CreateWorktreeOptions,
    signal?: AbortSignal,
  ): Promise<Result<GitWorktree, WorktreeError>> {
    // Pre-flight safety: branch must not already exist or be checked out.
    const branchExists = await this.branchExists(repositoryRoot, options.branchName, signal);
    if (!branchExists.ok) return branchExists;
    if (branchExists.value) {
      return err({
        kind: "validation",
        message: `Branch "${options.branchName}" already exists.`,
      });
    }

    const result = await this.git.run(
      [
        "worktree",
        "add",
        "-b",
        options.branchName,
        options.worktreePath,
        options.baseBranch,
      ],
      { cwd: repositoryRoot, signal },
    );
    if (!result.ok) return gitErr(result.error);

    // Read back the freshly created worktree entry.
    const listed = await this.listWorktrees(repositoryRoot, signal);
    if (!listed.ok) return listed;
    const created = listed.value.find(
      (w) => normalize(w.path) === normalize(options.worktreePath),
    );
    if (!created) {
      return err({
        kind: "git",
        error: new GitError(
          "Worktree was created but could not be found in the worktree list.",
          null,
          "",
          [],
        ),
      });
    }
    return ok(created);
  }

  async removeWorktree(
    repositoryRoot: string,
    worktreePath: string,
    options: RemoveWorktreeOptions = {},
    signal?: AbortSignal,
  ): Promise<Result<void, WorktreeError>> {
    if (!options.force) {
      const status = await this.status.getStatus(worktreePath, signal);
      // If we cannot read status, refuse rather than risk data loss.
      if (!status.ok) return gitErr(status.error);
      if (status.value.isDirty) {
        return err({
          kind: "dirty",
          message: `Worktree has ${status.value.changedFileCount} uncommitted change(s).`,
        });
      }
    }

    const args = ["worktree", "remove", worktreePath];
    if (options.force) args.push("--force");
    const result = await this.git.run(args, { cwd: repositoryRoot, signal });
    if (!result.ok) return gitErr(result.error);
    return ok(undefined);
  }

  /** Checks whether a local branch already exists. */
  async branchExists(
    repositoryRoot: string,
    branchName: string,
    signal?: AbortSignal,
  ): Promise<Result<boolean, WorktreeError>> {
    const result = await this.git.run(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      { cwd: repositoryRoot, signal },
    );
    // Exit 0 => exists; exit 1 => does not exist (not an error for us).
    if (result.ok) return ok(true);
    if (result.error.exitCode === 1) return ok(false);
    return gitErr(result.error);
  }

  /**
   * Lists tracked and untracked-but-not-ignored files in a worktree, for
   * @-mention autocomplete. Paths are worktree-relative, forward-slashed.
   */
  async listFiles(
    worktreePath: string,
    limit = 5000,
    signal?: AbortSignal,
  ): Promise<Result<string[], WorktreeError>> {
    const result = await this.git.run(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: worktreePath, signal },
    );
    if (!result.ok) return gitErr(result.error);
    const files = result.value.stdout
      .split("\0")
      .filter((f) => f.length > 0)
      .slice(0, limit);
    return ok(files);
  }

  /** Returns the current HEAD branch of the repository, if any. */
  async getCurrentBranch(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<Result<string | undefined, WorktreeError>> {
    const result = await this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: repositoryRoot,
      signal,
    });
    if (result.ok) return ok(result.value.stdout.trim() || undefined);
    if (result.error.exitCode === 1) return ok(undefined); // detached HEAD
    return gitErr(result.error);
  }
}

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
