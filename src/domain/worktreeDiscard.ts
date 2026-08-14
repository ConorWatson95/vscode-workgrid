/**
 * Which dirty paths a project has declared to be local environment rather than work.
 *
 * The problem this solves is a check *succeeding* at reporting a dirty tree while being
 * wrong about what that means. `Test-WorkLandedOnDev.ps1` refuses to promote from a
 * worktree with uncommitted changes — the check that stands between a route and a live
 * publish — and it failed on a task whose work was committed and pushed, because the
 * tree held nine files that were never work:
 *
 *   * `QubeAutoApp/Web.config`, transformed to run the solution from Visual Studio, so a
 *     checkout used for a non-default tenant carries a permanent modification.
 *   * Eight tracked files under each project's `bin/Debug/`, committed by mistake and rewritten by
 *     every build with the other line ending — a whole-file diff containing no change.
 *
 * Four worktrees were failing this way at once. A gate that fails on something the
 * operator cannot act on is one they learn to click past, which is the failure the whole
 * harness exists to prevent.
 *
 * Restored rather than ignored, because ignoring leaves the tree dirty and the next
 * stage inherits it — the next check then fails for the same reason and the gate has
 * gained nothing. Wanting a clean tree is the actual requirement.
 *
 * Pure and total, so the rules below are covered without a git repository. What the
 * caller does with the answer — running `git checkout --` and announcing it — is the
 * shell's business.
 */

/** One entry of `git status --porcelain`, reduced to what the decision needs. */
export interface WorktreeChange {
  /** Repo-relative, forward slashes, as git reports it. */
  path: string;
  /** The two status columns: index state, then working-tree state. */
  index: string;
  worktree: string;
}

export interface DiscardSelection {
  /** Paths to restore. */
  discard: string[];
  /**
   * Paths a pattern matched but which are deliberately left alone, with the reason.
   *
   * Reported rather than dropped: a declared path that stays dirty means the check
   * still fails, and "I told it to discard that" is then the operator's reasonable and
   * wrong conclusion. The reason is the only thing that closes that gap.
   */
  withheld: { path: string; reason: string }[];
}

/**
 * Parses `git status --porcelain` output.
 *
 * Deliberately the plain form rather than `-z`: this reads a tree that is about to be
 * altered, so a path containing a newline is one where the parse is uncertain — and the
 * entry is dropped instead of guessed at, since guessing wrong here deletes a file.
 * `parseStatusPorcelain` in `gitStatusService` can afford `-z` because it only counts.
 */
export function parsePorcelainChanges(output: string): WorktreeChange[] {
  const changes: WorktreeChange[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    // A rename reads "old -> new"; the destination is the file on disk.
    if (path.includes(" -> ")) path = path.split(" -> ").pop()!.trim();
    // git quotes a path containing unusual bytes. Unquoting it means decoding the
    // escapes, and a path we cannot reproduce exactly is one we must not pass to a
    // command that discards it.
    if (path.startsWith('"')) continue;
    if (!path) continue;
    changes.push({ path, index: line[0], worktree: line[1] });
  }
  return changes;
}

/**
 * Whether a declared pattern covers a path.
 *
 * Two forms, because the two real cases are different shapes. A pattern ending in `/`
 * is a directory and matches at any segment boundary, so `bin/Debug/` covers every
 * project's copy without the config listing seventeen of them. Anything else is an
 * exact path, so `QubeAutoApp/Web.config` cannot quietly widen to a file that merely
 * ends the same way.
 *
 * Case-insensitive, since these paths are compared on Windows — the same rule
 * `worktreePath` reconciliation follows.
 */
export function matchesDiscardPattern(path: string, pattern: string): boolean {
  const subject = path.replace(/\\/g, "/").toLowerCase();
  const wanted = pattern.replace(/\\/g, "/").toLowerCase();
  if (!wanted.endsWith("/")) return subject === wanted;
  return subject.startsWith(wanted) || subject.includes(`/${wanted}`);
}

/**
 * Splits a dirty tree into what may be restored and what may not.
 *
 * Three refusals, and each protects work that git could not give back:
 *
 *   * **Untracked files are never discarded.** Restoring a tracked file is a checkout
 *     from a commit; deleting an untracked one is unrecoverable, and untracked is
 *     exactly where new work lives.
 *   * **A staged change is never discarded.** Staging is deliberate, and `git checkout --`
 *     would not undo it anyway — so acting on it would need a harder command for a case
 *     that means the opposite of "this is local noise".
 *   * **A conflicted path is never discarded.** An unresolved merge is a state a human
 *     is in the middle of, and picking a side of it silently is not the harness's call.
 */
export function selectDiscardable(
  changes: readonly WorktreeChange[],
  patterns: readonly string[],
): DiscardSelection {
  const discard: string[] = [];
  const withheld: { path: string; reason: string }[] = [];

  for (const change of changes) {
    if (!patterns.some((pattern) => matchesDiscardPattern(change.path, pattern))) continue;

    if (change.index === "?" || change.worktree === "?") {
      withheld.push({
        path: change.path,
        reason: "untracked, so discarding it could not be undone",
      });
      continue;
    }
    if (change.index === "U" || change.worktree === "U") {
      withheld.push({ path: change.path, reason: "conflicted" });
      continue;
    }
    if (change.index !== " ") {
      withheld.push({
        path: change.path,
        reason: "staged, so the change was deliberate",
      });
      continue;
    }
    discard.push(change.path);
  }

  return { discard, withheld };
}

/**
 * What the stage report says about a discard.
 *
 * This is the safety margin, not decoration. `Web.config` is tracked and does take real
 * changes — a new `appSettings` key lands there — so a task that made one would have it
 * deleted by its own gate. Announced, that is a line someone can see and undo from the
 * commit; silent, it is indistinguishable from the change never having been made. Same
 * rule as truncated command output being announced rather than simply stopping.
 */
export function describeDiscard(selection: DiscardSelection): string | undefined {
  const lines: string[] = [];
  if (selection.discard.length > 0) {
    lines.push(
      `Discarded ${selection.discard.length} local change(s) declared in ` +
        "`worktree.discardPaths`, restoring the committed version:",
      ...selection.discard.map((path) => `- ${path}`),
    );
  }
  for (const { path, reason } of selection.withheld) {
    lines.push(`- Kept ${path}: ${reason}.`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
