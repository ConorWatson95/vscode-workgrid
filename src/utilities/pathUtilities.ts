import * as path from "node:path";
import { Result, ok, err } from "./result";

const RESERVED_WINDOWS_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export interface WorktreePathOptions {
  /** Absolute path to the repository root. */
  repositoryRoot: string;
  /** Branch slug (task name portion, no prefix). */
  slug: string;
  /** Configured parent directory; empty means "sibling of the repository". */
  configuredParentDir: string;
}

/**
 * Computes the absolute worktree path for a new task.
 *
 * Default (no configured parent): `<repoParent>/<repoName>-<slug>`.
 * Configured parent: `<configuredParent>/<repoName>-<slug>`.
 *
 * The result is always absolute and normalized for the host platform.
 */
export function buildWorktreePath(
  options: WorktreePathOptions,
): Result<string, string> {
  const { repositoryRoot, slug, configuredParentDir } = options;

  if (slug.length === 0) {
    return err("Cannot build a worktree path from an empty slug.");
  }
  const segmentCheck = validatePathSegment(slug);
  if (!segmentCheck.ok) {
    return segmentCheck;
  }

  const repoName = path.basename(repositoryRoot.replace(/[\\/]+$/, ""));
  const folderName = `${repoName}-${slug}`;

  const parent =
    configuredParentDir.trim().length > 0
      ? configuredParentDir
      : path.dirname(repositoryRoot);

  if (!path.isAbsolute(parent)) {
    return err(`Worktree parent directory must be absolute: "${parent}".`);
  }

  const resolved = path.resolve(parent, folderName);

  // Guard against a slug that escapes its parent (e.g. via traversal).
  const relative = path.relative(parent, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return err("Computed worktree path escapes its parent directory.");
  }

  return ok(resolved);
}

/** Rejects path segments containing separators, traversal, or reserved names. */
export function validatePathSegment(segment: string): Result<string, string> {
  if (segment.includes("/") || segment.includes("\\")) {
    return err("Path segment may not contain a path separator.");
  }
  if (segment === "." || segment === "..") {
    return err("Path segment may not be '.' or '..'.");
  }
  const base = segment.split(".")[0]?.toLowerCase() ?? "";
  if (RESERVED_WINDOWS_NAMES.has(base)) {
    return err(`"${segment}" is a reserved Windows name.`);
  }
  return ok(segment);
}
