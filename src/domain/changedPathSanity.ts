/**
 * Whether a changed-path set plausibly describes one task's work.
 *
 * The set is the sole input to the rules engine, and it is *derived* — three git
 * commands against a base branch — so it can be wrong in ways that look like a
 * very large change rather than like an error. When it is, every glob matches:
 * a task that had touched one stored procedure was appended an ETL review, a
 * resource-string culture review, a tenant-config review and a tooling test run,
 * each a full agent session.
 *
 * The branch guard catches the cause we found. This catches the shape, whatever
 * the cause — a stale base branch, a rebase, a squashed merge, a `baseBranch` that
 * was never right — because the next one will not be the one we already fixed.
 *
 * Deliberately dumb. A cleverer test (are the paths related? is the spread
 * plausible?) would have its own failure modes and be harder to explain when it
 * declined to run a review someone was relying on.
 */

/**
 * Above this many paths, the set is treated as describing a lineage rather than a
 * change, and rules are not applied.
 *
 * Chosen from what the two cases actually look like: the real task's own work was a
 * handful of files, and the two-branch diff that caused the incident was 9,569.
 * Between those, a genuine change of a few hundred files is rare and one of several
 * thousand is not a change at all. Erring high on purpose — a missed review is worse
 * than a slow one, so this must only fire on the obviously absurd.
 */
export const MAX_PLAUSIBLE_CHANGED_PATHS = 750;

export interface ImplausibleChangeSet {
  count: number;
  limit: number;
  /** Ready to log: says what was seen, what it means, and what to check. */
  message: string;
}

/**
 * Reports that a path set is too large to be one task's work, or undefined when it
 * is within reason.
 *
 * `baseBranch` is named in the message because it is the input most likely to be at
 * fault, and the one a reader can check in seconds.
 */
export function implausibleChangeSet(
  paths: readonly string[],
  baseBranch: string,
): ImplausibleChangeSet | undefined {
  if (paths.length <= MAX_PLAUSIBLE_CHANGED_PATHS) return undefined;
  return {
    count: paths.length,
    limit: MAX_PLAUSIBLE_CHANGED_PATHS,
    message:
      `${paths.length.toLocaleString("en-GB")} changed paths against "${baseBranch}" — ` +
      `more than ${MAX_PLAUSIBLE_CHANGED_PATHS}, so this is a diff between branch ` +
      `lineages rather than this task's work. Review rules are not being applied: ` +
      `against a set this size every rule matches, and each match is a full agent ` +
      `session on work the task never touched. Check that the worktree is on the ` +
      `task's branch and that "${baseBranch}" is the right base.`,
  };
}
