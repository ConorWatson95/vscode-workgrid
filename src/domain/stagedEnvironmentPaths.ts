import { matchesDiscardPattern, WorktreeChange } from "./worktreeDiscard";

/**
 * Commits that would carry a project's local environment into its history.
 *
 * The other half of `worktree.discardPaths`, and it exists because the first half was
 * read as covering something it never touched. `worktreeDiscard` answers "this check
 * must not fail on a file that was never work"; it runs from `runVerification`, which is
 * *after* the session, so by the time it looks the commit stage has already run its
 * `git add` and its `git commit`. The two failures are different and only one of them
 * had a mechanism:
 *
 *   * A gate failing on a dirty `Web.config` — prevented, by restoring the file.
 *   * That same `Web.config` reaching the branch — not prevented at all.
 *
 * Measured on a real task: a stage's diff carried `QubeAutoApp/Web.config` repointed at
 * another tenant's databases through an `sa` login, password inline, alongside the
 * work it was actually asked to do. Nothing in the runtime looked, because the file was
 * declared local environment and the declaration only ever reached the check.
 *
 * ## Why the gate, and why this is admissible there
 *
 * `permissionGatePolicy` refuses to replicate the CLI's "is this command safe"
 * classifier, and the reason that refusal does not extend to here is the same one
 * `credentialExposure` turns on. This asks no question about danger. It asks whether the
 * command would commit a path **the project itself declared is not work** — a fact about
 * this harness's own configuration, which no execution engine can know on its behalf.
 *
 * ## Bulk is refused; naming the file is not
 *
 * The obvious rule — refuse any commit touching a declared path — would close the only
 * legitimate route for a real change to one. `Web.config` does take genuine edits: a new
 * `appSettings` key lands there, and `selectDiscardable` deliberately withholds a
 * *staged* change for exactly that reason, so staging is the documented way to keep such
 * an edit through a discard. A blanket refusal would delete that escape and leave the
 * agent with no compliant form of the call at all — unlike a leaked credential, where
 * there is always a way to reword.
 *
 * So the distinction drawn is **incidental versus deliberate**. `git add -A` and
 * `git commit -a` sweep whatever happens to be dirty; the file is included because
 * nobody looked. `git add QubeAutoApp/Web.config` says so, in a command that
 * `SubtaskActivity.commands` records verbatim, which makes the decision auditable
 * afterwards by exactly the mechanism that caught the original failure. Refusing the
 * first and passing the second turns an invisible inclusion into a visible choice, and
 * costs a compliant stage one round trip.
 *
 * ## An already-staged path is already deliberate
 *
 * Only *unstaged* declared paths trigger a refusal. A staged one has been through this
 * rule once and passed it — either named explicitly, or staged by hand — so a later
 * `git commit -am` must not be refused on its account. Without that, the escape hatch
 * would work for `git add` and then fail at the commit, which is no escape hatch.
 *
 * ## Conflicted paths are left alone
 *
 * A bulk `git add` is how a merge conflict is normally resolved, and a stage held
 * mid-merge cannot proceed by any rewording. The same judgement `selectDiscardable`
 * makes about not picking a side of a conflict, for the opposite reason.
 *
 * Pure and vscode-free.
 */

/** Why a command was judged to sweep local environment into a commit. */
export interface EnvironmentStaging {
  /** The declared paths it would carry, as git spells them. */
  paths: string[];
}

/**
 * Global flags that may sit between `git` and its subcommand.
 *
 * A whitelist, because the two shapes cannot be told apart generically: `-C /repo` takes
 * a following value and `--no-pager` does not, so a pattern permitting an optional value
 * after any flag would read `add` as `--no-pager`'s argument and match nothing. Listing
 * the value-taking flags is small and stable, where guessing is wrong in the direction
 * of not firing — and a rule that silently never fires is the failure the quoted hook
 * command taught this codebase to fear.
 */
const GIT_PREFIX =
  "(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)(?:=|\\s+)\\S+\\s+|--[\\w-]+\\s+)*";

/**
 * A `git add` that stages by sweep rather than by name.
 *
 * `-A`/`--all` and `-u`/`--update` are the flag forms; `.` and `:/` are the pathspec
 * forms, and both are what an agent reaches for. A combined short flag is matched
 * character-wise, since `git add -Av` is one token carrying `-A`.
 */
const BULK_ADD = new RegExp(
  `\\bgit\\s+${GIT_PREFIX}add\\b(?=[^\\n;&|]*(?:\\s(?:-\\w*[Au]\\w*|--all|--update|--no-ignore-removal|\\.|:\\/|\\*)(?:\\s|$)))`,
);

/**
 * A `git commit` that stages every tracked modification first.
 *
 * `-a` is the whole hazard: it bypasses the index entirely, so a path nobody ever
 * staged is committed anyway. A plain `git commit` commits the index and is therefore
 * governed by whatever passed the `add` rule, which is the point.
 */
const BULK_COMMIT = new RegExp(
  `\\bgit\\s+${GIT_PREFIX}commit\\b(?=[^\\n;&|]*\\s(?:-\\w*a\\w*|--all)(?:\\s|$))`,
);

/**
 * Whether the command stages or commits by sweep.
 *
 * Exported because it is the cheap pre-filter the caller applies *before* reading the
 * worktree: the gate fires on every tool call, and a `git status` on each one would put
 * a quarter of a second in front of every command a stage runs. Only a command that
 * could sweep is worth the read.
 */
export function stagesInBulk(command: string): boolean {
  if (!command.trim()) return false;
  return BULK_ADD.test(command) || BULK_COMMIT.test(command);
}

/**
 * Whether the command names a path explicitly, making its inclusion deliberate.
 *
 * Matched on the **last segment**, the same deliberately-loose rule `claimEvidence`
 * uses and for the same reason: a command spells a path however its own shell does
 * (`QubeAutoApp/Web.config`, `QubeAutoApp\Web.config`, `./Web.config`), and a
 * declaration lost to a spelling difference would refuse a call the operator meant to
 * allow. Loose is safe here because the failure direction is a passed call that is
 * recorded verbatim, not a deleted file.
 */
export function namesPathExplicitly(command: string, path: string): boolean {
  const segment = path.replace(/\\/g, "/").split("/").pop();
  if (!segment) return false;
  return new RegExp(`(^|[\\s"'/\\\\=])${escapeRegExp(segment)}($|[\\s"';])`, "i").test(
    command,
  );
}

/**
 * Judges one command against the declared paths and the tree as it stands.
 *
 * Returns undefined when there is nothing to refuse — no declarations, not a bulk
 * command, or nothing declared currently dirty and unstaged — so the common case costs
 * a regex and the gate stays out of the way.
 */
export function findEnvironmentStaging(input: {
  command: string;
  patterns: readonly string[];
  changes: readonly WorktreeChange[];
}): EnvironmentStaging | undefined {
  const { command, patterns, changes } = input;
  if (patterns.length === 0) return undefined;
  if (!stagesInBulk(command)) return undefined;

  const paths: string[] = [];
  for (const change of changes) {
    if (!patterns.some((pattern) => matchesDiscardPattern(change.path, pattern))) continue;
    // Mid-merge; a bulk add is how that is resolved.
    if (change.index === "U" || change.worktree === "U") continue;
    // The only pass, and it is the whole escape hatch: nothing is dirty in the working
    // tree, so whatever is staged got there deliberately — named through this rule, or
    // staged by hand — and a later `git commit -am` must not be refused on its account.
    //
    // Deliberately keyed on the *worktree* column alone. A path both staged and further
    // modified (`MM`) is still refused: the staged version passed, and the delta on top
    // of it did not. That happens when a build rewrites a file after it was staged,
    // which is exactly the sort of change nobody chose.
    if (change.worktree === " ") continue;
    if (namesPathExplicitly(command, change.path)) continue;
    paths.push(change.path);
  }

  return paths.length > 0 ? { paths } : undefined;
}

/**
 * What the agent is told when a bulk commit is refused.
 *
 * Names the paths, which is the one piece of project knowledge admissible here: they
 * came from the project's own `harness.json`, so repeating them back is not the runtime
 * inventing engineering advice — the line `credentialExposure` holds. What it must not
 * do is say which of them belongs in the commit, because that is the judgement being
 * handed to the agent rather than made for it.
 *
 * Says how to comply, in both directions. A refusal with only a prohibition in it is
 * one the agent routes around, and here routing around means committing anyway from a
 * shell it thinks is unwatched, or abandoning a real edit that belonged in the change.
 */
export function environmentStagingReason(staging: EnvironmentStaging): string {
  return [
    "This call was refused because it stages by sweep, and this repository declares",
    "the following dirty path(s) to be local environment rather than work:",
    "",
    ...staging.paths.map((path) => `  ${path}`),
    "",
    "Committing those carries one developer's machine — tenant pointers, connection",
    "details, build output — into the branch and into its history permanently. Nothing",
    "has gone wrong with your work, and the files have not been altered.",
    "",
    "Stage what you changed by path instead of sweeping. If one of the paths above is",
    "genuinely part of this change, add it by name in its own command: naming it is",
    "recorded and reviewable, where sweeping it is not. If you are unsure whether it",
    "belongs, ask rather than including it.",
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
