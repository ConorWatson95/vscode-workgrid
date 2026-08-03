import { GitClient } from "./gitClient";
import { GitStatus, GitDiffSummary } from "./types";
import { Result, ok } from "../utilities/result";
import { GitError } from "./gitClient";

/**
 * Parses `git status --porcelain=v1 -z --branch` output.
 *
 * In `-z` mode every line (including the `## branch` header produced by
 * `--branch`) is NUL-terminated. Rename/copy entries consume an extra
 * NUL-separated field (the origin path), which we skip.
 */
export function parseStatusPorcelain(output: string): GitStatus {
  const parts = output.split("\0");
  let changed = 0;
  let branch: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;

    if (entry.startsWith("## ")) {
      branch = parseBranchHeader(entry);
      continue;
    }
    if (entry.length < 3) continue;

    const xy = entry.slice(0, 2);
    changed++;
    if (xy[0] === "R" || xy[0] === "C") {
      i++; // skip the rename/copy source path field
    }
  }

  return { isDirty: changed > 0, changedFileCount: changed, branch };
}

export class GitStatusService {
  constructor(private readonly git: GitClient) {}

  async getStatus(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<Result<GitStatus, GitError>> {
    const result = await this.git.run(
      ["status", "--porcelain=v1", "-z", "--branch"],
      { cwd: worktreePath, signal },
    );
    if (!result.ok) return result;
    return ok(parseStatusPorcelain(result.value.stdout));
  }

  /** Counts commits on the worktree's HEAD that are not on the base branch. */
  async getCommitsAhead(
    worktreePath: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<Result<number, GitError>> {
    const result = await this.git.run(
      ["rev-list", "--count", `${baseBranch}..HEAD`],
      { cwd: worktreePath, signal },
    );
    if (!result.ok) return result;
    const n = Number(result.value.stdout.trim());
    return ok(Number.isFinite(n) ? n : 0);
  }

  async getDiffSummary(
    worktreePath: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<Result<GitDiffSummary, GitError>> {
    const result = await this.git.run(
      ["diff", "--shortstat", `${baseBranch}...HEAD`],
      { cwd: worktreePath, signal },
    );
    if (!result.ok) return result;
    return ok(parseShortStat(result.value.stdout));
  }

  /**
   * Every path this task has touched relative to its base branch: committed
   * changes, uncommitted working-tree changes, and untracked files.
   *
   * This is the input to the review-rules engine, so it errs towards inclusion —
   * a file that is changed but not yet committed still obliges the reviews its
   * path implies.
   */
  async getChangedPaths(
    worktreePath: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<Result<string[], GitError>> {
    const committed = await this.git.run(
      ["diff", "--name-only", "-z", `${baseBranch}...HEAD`],
      { cwd: worktreePath, signal },
    );
    if (!committed.ok) return committed;

    const working = await this.git.run(["diff", "--name-only", "-z", "HEAD"], {
      cwd: worktreePath,
      signal,
    });
    if (!working.ok) return working;

    const untracked = await this.git.run(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: worktreePath, signal },
    );

    return ok(
      mergeChangedPaths([
        committed.value.stdout,
        working.value.stdout,
        untracked.ok ? untracked.value.stdout : "",
      ]),
    );
  }

  /**
   * Produces a readable unified diff for a task: committed changes vs the base
   * branch, followed by any uncommitted working-tree changes. Untracked files
   * are listed by name (git diff does not include their contents).
   */
  async getFullDiff(
    worktreePath: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<Result<string, GitError>> {
    const committed = await this.git.run(["diff", `${baseBranch}...HEAD`], {
      cwd: worktreePath,
      signal,
    });
    if (!committed.ok) return committed;

    const working = await this.git.run(["diff", "HEAD"], { cwd: worktreePath, signal });
    if (!working.ok) return working;

    const untracked = await this.git.run(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: worktreePath, signal },
    );

    const sections: string[] = [];
    if (committed.value.stdout.trim()) {
      sections.push(`# Committed changes vs ${baseBranch}\n\n${committed.value.stdout.trimEnd()}`);
    }
    if (working.value.stdout.trim()) {
      sections.push(`# Uncommitted changes (working tree)\n\n${working.value.stdout.trimEnd()}`);
    }
    if (untracked.ok) {
      const files = untracked.value.stdout.split("\0").filter(Boolean);
      if (files.length > 0) {
        sections.push(`# Untracked files\n\n${files.map((f) => `+ ${f}`).join("\n")}`);
      }
    }

    return ok(sections.length > 0 ? sections.join("\n\n\n") : "No changes relative to the base branch.");
  }
}

/**
 * Merges several NUL-separated `--name-only` outputs into one de-duplicated,
 * sorted path list. Paths are normalised to forward slashes so review rules can
 * be written one way regardless of platform.
 *
 * A path appearing in both the committed diff and the working tree is one
 * changed file, not two — de-duplication matters because rule matches are
 * reported per rule and inflated inputs would mislead the explanation shown to
 * the user.
 */
export function mergeChangedPaths(outputs: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const output of outputs) {
    for (const entry of output.split("\0")) {
      const trimmed = entry.trim();
      if (trimmed) paths.add(trimmed.replace(/\\/g, "/"));
    }
  }
  return [...paths].sort();
}

/** Extracts the branch name from a `## main...origin/main` header line. */
export function parseBranchHeader(header: string): string | undefined {
  const match = header.match(/^## (?:No commits yet on )?([^ .]+)/);
  if (!match) return undefined;
  const branch = match[1];
  return branch === "HEAD" ? undefined : branch;
}

/** Parses `git diff --shortstat`: "3 files changed, 12 insertions(+), 4 deletions(-)". */
export function parseShortStat(output: string): GitDiffSummary {
  const files = /(\d+) files? changed/.exec(output);
  const ins = /(\d+) insertions?\(\+\)/.exec(output);
  const del = /(\d+) deletions?\(-\)/.exec(output);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}
