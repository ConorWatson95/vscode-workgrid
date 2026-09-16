/**
 * A recorded file path, as something a reader can click.
 *
 * The stage report lists what a subtask wrote and read, and every one was plain
 * code text — so reviewing a stage meant reading a path, copying it, and finding
 * the file by hand, several dozen times over for a stage like `rc-implement-app`.
 * The paths are already recorded verbatim; nothing new has to be captured to make
 * them openable.
 *
 * The load-bearing part is *which copy* opens. A stage session runs with the
 * worktree as its cwd, so a relative path it recorded means the worktree's file —
 * and a link resolved against the main checkout would open the same path on the
 * base branch. That is the file the reviewer is not reviewing, it looks almost
 * identical, and nothing on screen would say which one they were reading. So every
 * link is made absolute against the worktree, and a path that cannot be made
 * absolute is left as plain text rather than linked to a guess.
 *
 * Pure and vscode-free: the report is markdown, and `file:` URIs are what its
 * preview opens.
 */

/** Windows drive letter, POSIX root, or a UNC share. */
function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

/**
 * `file:` URI for a path already known to be absolute.
 *
 * Encoded per segment, so a space or a `#` in a path survives — worktree roots here
 * are slugified task names and carry neither, but the main checkout sits under a
 * profile directory that routinely does, and that is the unquoted-hook-command
 * lesson in a smaller box.
 */
function fileUri(absolute: string): string {
  const normalised = absolute.replace(/\\/g, "/");
  const encoded = normalised
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  // A drive letter's colon is the one character that must survive encoding, or the
  // URI names a host rather than a path.
  const restored = encoded.replace(/^([a-zA-Z])%3A/, "$1:");
  return restored.startsWith("/") ? `file://${restored}` : `file:///${restored}`;
}

/**
 * The recorded path as a markdown link, or as inline code when it cannot be resolved.
 *
 * The visible text is always the path exactly as the session recorded it. A reader
 * comparing the report against a diff is matching those strings, and rewriting them
 * to absolute form for display would turn a short relative path into a line of
 * directory prefix — the abridgement rule, the other way round.
 */
export function fileLink(path: string, worktreePath: string | undefined): string {
  const trimmed = path.trim();
  if (!trimmed) return "";

  const absolute = isAbsolute(trimmed)
    ? trimmed
    : worktreePath
      ? `${worktreePath.replace(/[\\/]+$/, "")}/${trimmed.replace(/^\.?[\\/]+/, "")}`
      : undefined;

  // Absence of a worktree means unchanged: an older task, or a report opened for a
  // task whose worktree is gone, renders exactly as it did before.
  if (!absolute) return `\`${trimmed}\``;
  return `[\`${trimmed}\`](${fileUri(absolute)})`;
}
