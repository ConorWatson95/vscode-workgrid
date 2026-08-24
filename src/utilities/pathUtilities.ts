import * as crypto from "node:crypto";
import * as path from "node:path";
import { Result, ok, err } from "./result";

/**
 * Longest directory name we will generate for a worktree.
 *
 * A task name here is routinely a whole sentence, and the folder name was
 * `<repo>-<the whole thing slugified>` with no cap — which produced roots of 121,
 * 146 and 173 characters. That is not a cosmetic problem: `devenv.exe` carries no
 * `longPathAware` manifest entry, so the machine-wide `LongPathsEnabled` flag does
 * not apply to it and Visual Studio is still hard-capped at MAX_PATH. A 270-char
 * NuGet targets path inside a 121-char worktree therefore failed to load with
 * "Could not find a part of the path" against a file that was plainly there —
 * while `MSBuild.exe`, which *is* manifested, built the same import happily. So the
 * two tools disagree about whether the worktree exists, and only one of them is the
 * one you open the solution in.
 *
 * 60 is chosen against a measured tail: the deepest tracked path in the repository
 * that provoked this was 170 characters, so a root of 88 or less clears 259 with the
 * separator. A 17-character parent (`C:/Dev/worktrees/`) plus a 60-character folder
 * name is 77, leaving room for a longer parent and for build output below the
 * tracked tail.
 */
export const MAX_WORKTREE_FOLDER_NAME = 60;

/** Hex characters of slug digest appended when the name had to be truncated. */
const DISAMBIGUATOR_LENGTH = 6;

/**
 * Shortens a folder name to the cap, keeping it distinguishable.
 *
 * The truncated portion is replaced by a digest of the **whole** slug rather than
 * simply cut, because task names here share long prefixes — two campaign tasks
 * beginning "include-retail-r2-dealers-in-trade-parts-rebate-campaigns-" would
 * otherwise collide on one directory, and the second task would be handed the
 * first one's worktree. Truncation stops at a hyphen where one is nearby, so the
 * name still reads as words rather than a word cut in half.
 *
 * Only the *directory* is capped. The branch keeps the full slug: refs have no
 * length limit worth worrying about, and the branch name is how the work is
 * recognised in a commit, a pull request and a stand-up.
 */
function capFolderName(repoName: string, slug: string): string {
  const full = `${repoName}-${slug}`;
  if (full.length <= MAX_WORKTREE_FOLDER_NAME) return full;

  const digest = crypto
    .createHash("sha1")
    .update(slug)
    .digest("hex")
    .slice(0, DISAMBIGUATOR_LENGTH);
  const suffix = `-${digest}`;
  const room = MAX_WORKTREE_FOLDER_NAME - suffix.length;

  // A repository name long enough to leave no room for any of the slug is not
  // worth truncating further — the repo name is the part that tells you which
  // checkout this is, so it is kept whole and the cap is overshot instead.
  if (room <= repoName.length + 1) return `${repoName}${suffix}`;

  let head = full.slice(0, room);
  const lastHyphen = head.lastIndexOf("-");
  if (lastHyphen > repoName.length) head = head.slice(0, lastHyphen);
  return `${head}${suffix}`;
}

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
 * The folder name is capped at `MAX_WORKTREE_FOLDER_NAME`; see `capFolderName` for
 * why, and for why the branch name is deliberately not.
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
  const folderName = capFolderName(repoName, slug);

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
