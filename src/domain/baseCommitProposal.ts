/**
 * Recovering the commit a branch was cut from, for a task recorded before
 * `TaskWorkspace.baseCommit` existed.
 *
 * The field cannot be backfilled by computing a merge-base, and that is not a
 * limitation of the implementation — it is arithmetic. `merge-base(branch, base)` is
 * the fork point only while the branch is unmerged; once its work has landed on the
 * base the merge-base *is* the branch's own tip. So on exactly the tasks that most
 * need the field, the obvious derivation returns a value that is confidently wrong,
 * and a wrong `baseCommit` is worse than none: it enumerates another ticket's commits
 * and demands they be promoted.
 *
 * Deriving it from the base branch's merge history does not work either, and this was
 * tried before it was written off. "The earliest merge into DEV whose second parent is
 * an ancestor of this branch" sounds like the fork point and is not: a task branch cut
 * from DEV contains all of DEV's history, so nearly every merge ever made satisfies
 * that test. On NMGB-2533 it returned a commit from **2021** and a set of 7,221
 * commits.
 *
 * What does hold the answer is the branch's own reflog, which records the value a ref
 * took at creation:
 *
 *     7fe00c7e8c64e8abb392570373447ba4387385fe    branch: Created from DEV
 *
 * Verified on NMGB-2533: that commit yields exactly the branch's 12 commits, two of
 * which carry no ticket in their subject and were being scoped wrong by the check that
 * infers the set from commit subjects.
 *
 * **A proposal, never a derivation**, which is the whole reason this module returns
 * something a human is shown rather than something a service applies. Reflogs are
 * local to a clone, expire (90 days by default), and are absent or trimmed on plenty of
 * real branches — sampled across four in-flight tasks, two had the entry, one had a
 * reflog with the creation trimmed away, and one had no reflog at all. So this cannot
 * be a silent backfill; it is the same shape as the assessment stage, which records its
 * conclusions and lets `approveStage` apply them, and as `suggestionLookup`, where a
 * ref is verified against the source rather than typed.
 *
 * Pure and vscode-free: the caller runs git and hands the output here.
 */

/** What the reflog says about where a branch began. */
export interface BranchCreation {
  /** The value the ref took at creation — the fork point. */
  commit: string;
  /**
   * What the reflog says it was created from, verbatim.
   *
   * Reported rather than checked, because it is a *name* recorded at creation and the
   * task's `baseBranch` is a name recorded separately. They usually agree; when they do
   * not, the operator is the one who can say whether the branch was cut from somewhere
   * else or simply renamed since. Refusing on a mismatch would withhold the answer in
   * precisely the case where recovering it by hand is hardest.
   */
  createdFrom: string;
}

/** `<full sha><tab>branch: Created from <ref>` — the shape `%H%x09%gs` produces. */
const CREATION = /^([0-9a-f]{7,40})\t(?:branch|Branch): [Cc]reated from (.+)$/;

/**
 * The most recent creation entry in `git reflog show --format='%H%x09%gs' <branch>`.
 *
 * Reflog output runs newest first, so the **first** creation entry encountered is the
 * current lineage of the ref. That matters for a branch deleted and cut again: the
 * older entry describes a branch that no longer exists, and taking it would enumerate
 * commits from a lineage this task never had.
 *
 * Returns undefined for a reflog that has none — a trimmed one, a fresh clone, or
 * git's own error text, which reaches here as ordinary non-matching lines rather than
 * as a special case.
 */
export function parseBranchCreation(reflog: string): BranchCreation | undefined {
  for (const line of reflog.split(/\r?\n/)) {
    const match = CREATION.exec(line.trim());
    if (match) return { commit: match[1], createdFrom: match[2].trim() };
  }
  return undefined;
}

/** Refs belonging to other work, found among the commits a proposal would establish. */
export interface ForeignReferences {
  /** The other refs seen, in first-seen order. */
  refs: string[];
  /** How many of the commits carry one. */
  commits: number;
}

/**
 * Other tickets' references among the commits a proposed base commit would establish.
 *
 * A **warning, never a filter**, and the numbers are why. On
 * `feature/renaultgb-myrewards-summary` the fork point yields 103 commits of which 75
 * carry no reference at all — so keeping only the ones that name this task's ticket
 * would discard three quarters of the set, most of it genuine. A commit with no ref is
 * not evidence of anything.
 *
 * A commit naming a *different* ticket is different in kind: it is proof the proposal
 * has swept in work this task did not do, which is exactly the contamination that makes
 * a fork point untrustworthy on a branch that has integrated its base. Six such tickets
 * appeared in that branch's 103, and one of the commits sampled from it is on
 * `origin/DEV` and fifteen other branches.
 *
 * **The convention is the project's, never this module's.** Leading every commit with a
 * ticket key is how one repository happens to work; `pattern` comes from the project's
 * own suggestion source, and a project whose refs are numbers or GUIDs supplies its own
 * or gets no warning rather than a wrong one.
 */
export function foreignReferences(
  subjects: readonly string[],
  ownRef: string | undefined,
  pattern?: RegExp,
): ForeignReferences {
  const matcher = pattern ?? DEFAULT_REF;
  const mine = ownRef?.trim().toLowerCase();
  const refs: string[] = [];
  let commits = 0;

  for (const subject of subjects) {
    const found = [...subject.matchAll(new RegExp(matcher.source, "g"))]
      .map((match) => match[0])
      .filter((ref) => ref.toLowerCase() !== mine);
    if (found.length === 0) continue;
    commits += 1;
    for (const ref of found) if (!refs.includes(ref)) refs.push(ref);
  }

  return { refs, commits };
}

/**
 * The shape a ticket key takes when a project declares none.
 *
 * Deliberately a copy of `TICKET_PATTERN` rather than an import: this module is about
 * commit provenance, and coupling it to the ticket-reference domain would make a change
 * there silently change what counts as contamination here.
 */
const DEFAULT_REF = /[A-Z][A-Z0-9]+-[0-9]+/;

/** Why a proposed base commit must not be recorded. */
export type BaseCommitRefusal =
  /** The task already has one. Changing it is a separate, deliberate act. */
  | "already-recorded"
  /** Nothing in the reflog says where the branch began. */
  | "not-in-reflog"
  /**
   * The commit is not an ancestor of the branch.
   *
   * The check that makes a mistyped or stale value harmless. `rev-list <branch>
   * ^<commit>` against a non-ancestor does not fail — it quietly returns the branch's
   * entire history, which is the enumeration this field exists to make exact.
   */
  | "not-an-ancestor";

/**
 * Whether a proposed base commit may be recorded on a task.
 *
 * `ancestor` is supplied by the caller because only git can answer it, and it is asked
 * of a *candidate the operator may have typed* as much as of one the reflog proposed.
 */
export function mayRecordBaseCommit(input: {
  existing?: string;
  candidate?: string;
  ancestor: boolean;
}): BaseCommitRefusal | undefined {
  if (input.existing) return "already-recorded";
  if (!input.candidate) return "not-in-reflog";
  if (!input.ancestor) return "not-an-ancestor";
  return undefined;
}
