/**
 * What `git merge` did, read from its own output.
 *
 * Pure and vscode-free, like `worktreeParser`: classifying a merge is the part
 * worth testing, and it needs no process to test it.
 *
 * The distinction that matters is between a merge that *started* and left the tree
 * half-merged, and one that refused to start at all. Only the first has anything to
 * abort, and calling `--abort` on the second fails with "there is no merge to
 * abort" — which then gets reported instead of the actual problem.
 */

export type MergeOutcome =
  /** The branch was already contained in HEAD. Nothing changed. */
  | { kind: "up-to-date" }
  | { kind: "merged"; fastForward: boolean }
  /** The merge began and stopped with conflicts. The tree needs abort or resolution. */
  | { kind: "conflicted"; paths: string[] }
  /**
   * git declined before touching anything, because local changes would be lost.
   * Distinct from `conflicted`: there is no merge in progress to abort, and the
   * fix is to commit or stash rather than to resolve anything.
   */
  | { kind: "blocked"; paths: string[]; message: string }
  | { kind: "failed"; message: string };

export interface MergeCommandOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Paths git names as conflicting.
 *
 * Both spellings are matched because they carry the path in different places:
 * `CONFLICT (content): Merge conflict in src/a.ts` puts it last, while
 * `CONFLICT (modify/delete): src/b.ts deleted in ...` puts it first.
 */
export function parseConflictPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("CONFLICT")) continue;

    const inMatch = /Merge conflict in (.+)$/.exec(trimmed);
    if (inMatch) {
      paths.push(inMatch[1].trim());
      continue;
    }
    // "CONFLICT (modify/delete): <path> deleted in <ref> and modified in HEAD."
    const afterColon = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    const word = /^(\S+?)\s+(?:deleted|added|renamed)\b/.exec(afterColon);
    if (word) paths.push(word[1]);
  }
  return [...new Set(paths)];
}

/**
 * Paths git says a merge would overwrite.
 *
 * Listed one per line, indented, under a heading — and terminated by the
 * "Please commit…" advice, which must not be collected as a filename.
 */
export function parseOverwrittenPaths(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((line) =>
    /would be overwritten by merge:/i.test(line),
  );
  if (heading < 0) return [];

  const paths: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    // Indentation is what marks a path as part of the list; the advice that
    // follows is flush-left.
    if (!/^\s+\S/.test(line)) break;
    paths.push(line.trim());
  }
  return paths;
}

export function classifyMerge(output: MergeCommandOutput): MergeOutcome {
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;

  if (output.exitCode === 0) {
    // git's wording has varied ("Already up to date." / "Already up-to-date."),
    // so match the stable part rather than the sentence.
    if (/already up[- ]to[- ]date/i.test(stdout)) return { kind: "up-to-date" };
    return { kind: "merged", fastForward: /Fast-forward/i.test(stdout) };
  }

  const overwritten = parseOverwrittenPaths(combined);
  if (overwritten.length > 0) {
    return {
      kind: "blocked",
      paths: overwritten,
      message:
        "Local changes in the worktree would be overwritten. Commit or stash them first.",
    };
  }

  if (/^CONFLICT|Automatic merge failed/im.test(combined)) {
    return { kind: "conflicted", paths: parseConflictPaths(stdout) };
  }

  const message = stderr.trim() || stdout.trim() || `git merge exited ${output.exitCode}`;
  return { kind: "failed", message };
}

/** True when a merge is part-applied and the worktree needs `--abort`. */
export function leavesMergeInProgress(outcome: MergeOutcome): boolean {
  return outcome.kind === "conflicted";
}
