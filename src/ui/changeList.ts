import { ChangedFile } from "../git/gitStatusService";

/**
 * Turns "what this task did to each file" into the two sides a diff editor needs.
 *
 * Pure and separate from the command because this is where the file-by-file view
 * is actually right or wrong: getting a side backwards renders an added file as a
 * wholesale deletion, which is both alarming and the exact opposite of the truth.
 */

/** Where one side of a comparison comes from. */
export type ChangeSide =
  /** The file does not exist on this side — an added file's before, or a deleted file's after. */
  | { kind: "empty" }
  /** Read from git at a revision. `path` differs from the row's path for a rename. */
  | { kind: "blob"; revision: string; path: string }
  /** The file as it is on disk in the worktree right now. */
  | { kind: "worktree"; path: string };

export interface ChangeRow {
  /** Path relative to the worktree, forward-slashed. Identifies the row. */
  path: string;
  status: ChangedFile["status"];
  before: ChangeSide;
  after: ChangeSide;
}

export function changeRows(
  files: readonly ChangedFile[],
  mergeBase: string,
): ChangeRow[] {
  return files.map((file) => ({
    path: file.path,
    status: file.status,
    before:
      file.status === "added"
        ? { kind: "empty" as const }
        : {
            kind: "blob" as const,
            revision: mergeBase,
            // A rename's before side lives at the old path; reading the new path at
            // the base would find nothing and show the file as newly added.
            path: file.origin ?? file.path,
          },
    after:
      file.status === "deleted"
        ? { kind: "empty" as const }
        : { kind: "worktree" as const, path: file.path },
  }));
}

/** Short status word for a row, for a list that shows more than file names. */
export function statusLabel(file: ChangedFile): string {
  if (file.status === "renamed" && file.origin) return `renamed from ${file.origin}`;
  if (file.status === "added" && file.untracked) return "added (not yet committed)";
  return file.status;
}

/** Counts for a one-line summary above a file list. */
export function changeSummary(files: readonly ChangedFile[]): string {
  if (files.length === 0) return "no changes";
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
  const order: ChangedFile["status"][] = ["added", "modified", "renamed", "deleted"];
  const parts = order
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status}`);
  return `${files.length} ${files.length === 1 ? "file" : "files"} · ${parts.join(", ")}`;
}
