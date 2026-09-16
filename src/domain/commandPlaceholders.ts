/**
 * Substitution for the commands a route declares.
 *
 * A `verify` command is handed to the shell verbatim, so a check written once for a
 * route could not name the task it was running for. Two live consequences, both from
 * the same afternoon:
 *
 * - A script asserting the publish worktrees were ready could not reject one parked
 *   on *another* ticket's promotion, because it had no way to know its own ticket. It
 *   degraded to an existence check — which passes in exactly the case that matters.
 * - The same script demanded all three publish worktrees regardless of ticket, when a
 *   single-project ticket needs one.
 *
 * Both are answered by letting the command say `${taskName}`.
 *
 * **Unknown placeholders are left exactly as written.** `${...}` is real syntax in
 * both PowerShell and bash, so a command referring to a shell variable must reach the
 * shell unchanged; substituting or blanking it would corrupt working commands to
 * catch typos. The unrecognised names are reported instead, so a caller can say so
 * without changing what runs.
 *
 * Pure and vscode-free.
 */

/** What a command may refer to. Every value is a fact about the task, not config. */
export interface CommandPlaceholders {
  taskName: string;
  /** The branch the task's work is on. */
  branch: string;
  /** What that branch was cut from. */
  baseBranch: string;
  /**
   * The commit it was cut from, or undefined on a task that predates it being recorded.
   *
   * Undefined is a real answer, exactly as it is for `ticket`, and for a sharper reason:
   * a check enumerating this task's commits as `rev-list <branch> ^<baseCommit>` must
   * not run with the placeholder blanked, because `rev-list <branch>` is the entire
   * history and would demand every commit in the repository be promoted. `missing`
   * keeps it verbatim so the failure names its own cause.
   */
  baseCommit?: string;
  /**
   * The commit this branch diverged from its base at, or undefined when git cannot say.
   *
   * For a check that asks *what did this branch change*. `${baseBranch}` names a moving
   * ref, and a script diffing against its tip answers a different question — how this
   * branch differs from the base **right now** — so every file anyone else lands after
   * the branch was cut is reported as this branch's work.
   *
   * Measured on `qubeautoapp`, 15 Sep 2026: a smoke-script check run that way demanded
   * scripts for procedures across four manufacturers the task had never touched, all of
   * them landed on the base that same day by two other people. On one task branch it saw
   * 31 changed SQL files where the branch had changed none; on a second, 77 against the
   * tip and 40 from here; a third spent six days and five retries failing on two
   * procedures it did not own. Nine of the nine entries in that repository's failure
   * ledger were checks failing, and none was the work failing.
   *
   * Derived per run, never the recorded `baseCommit`: a task that merges its base in —
   * normal on anything long-running — moves the divergence point forward, and diffing
   * from the original cut would then report everything merged in as the branch's own.
   *
   * Undefined is a real answer, and it stops the check rather than running it: a check
   * that cannot establish what this branch changed must not run comparing against
   * something else, which is the failure above with the base merely spelled differently.
   */
  mergeBase?: string;
  /** Absolute path of the task's worktree. */
  worktreePath: string;
  /**
   * Absolute path of the repository the task belongs to.
   *
   * For naming a check's own script. A command runs with the **worktree** as its working
   * directory — which is right, since a check inspects the tree it is certifying — so a
   * relative path like `tools/git/Test-WorkPromoted.ps1` resolves to the *branch's* copy.
   * The declaration is read from the repository root precisely so a branch cannot choose
   * the command that certifies it, and that was enforced on the string while the file it
   * named came from the branch anyway.
   *
   * The benign version is staleness, and it happened: a task branch cut before two fixes
   * to a promotion check ran the old script and failed on a bug fixed days earlier, with
   * a message describing the fixed behaviour. The sharp version is a branch editing the
   * script to `exit 0` and passing its own gate.
   */
  repoRoot: string;
  /**
   * The ticket this task is about, or undefined when nothing establishes one.
   *
   * Undefined is a real answer rather than an empty string: a check scoped by ticket
   * must not run scoped to nothing, and the two are told apart in `missing` below.
   * See `domain/ticketReference.ts`.
   */
  ticket?: string;
}

const KNOWN = [
  "taskName",
  "branch",
  "baseBranch",
  "worktreePath",
  "repoRoot",
  "ticket",
  "baseCommit",
  "mergeBase",
] as const;

/**
 * What to do about a placeholder this knows and has no value for.
 *
 * Kept beside the names rather than at the call site because the remedies are not
 * interchangeable: the message used to tell anyone reading it to link a ticket,
 * whichever name was missing, so a check that could not find a merge base would have
 * sent its operator to the ticket picker.
 */
const REMEDY: Partial<Record<(typeof KNOWN)[number], string>> = {
  ticket:
    "Link the task to its ticket (Set Ticket Reference…), or put the reference in the " +
    "task's name.",
  baseCommit:
    "This task predates the base commit being recorded. Re-create it from its branch, " +
    "or change the check to name ${mergeBase}, which is derived per run.",
  mergeBase:
    "Git could not find where this branch diverged from its base. Check the task's base " +
    "branch exists in the repository and shares history with the branch.",
};

/** The remedy lines for names that had no value, in the order given. */
export function remediesFor(missing: readonly string[]): string[] {
  return missing
    .map((name) => REMEDY[name as (typeof KNOWN)[number]])
    .filter((line): line is string => line !== undefined);
}

export interface Substitution {
  command: string;
  /** Names substituted, in the order they first appeared. For the log. */
  used: string[];
  /**
   * `${...}` names this does not know, left verbatim in the command.
   *
   * Reported rather than treated as an error: most are shell variables and entirely
   * intentional. A caller that wants to warn about a misspelled `${taskname}` can,
   * without this deciding that a working command is wrong.
   */
  unknown: string[];
  /**
   * Names this knows but has no value for, left verbatim in the command.
   *
   * Separate from `unknown`, because the remedies are opposites: an unknown name is
   * usually a shell variable and needs nothing done, while a missing one is a fact
   * about the task that nothing established — a promotion check scoped by ticket, on a
   * task linked to no ticket.
   *
   * Left verbatim rather than blanked, so the failure names its own cause. A script
   * reporting `no ticket reference could be found in '${ticket}'` says the placeholder
   * did not resolve; the same message about `''` says only that something was empty.
   * Substituting nothing would also silently *unscope* a check whose entire value is
   * being scoped — the failure this exists to prevent.
   */
  missing: string[];
}

/**
 * Replaces the placeholders a command names with this task's values.
 *
 * Values are inserted raw. The command is project config authored by whoever owns the
 * route — it already runs an arbitrary shell command, so quoting it here would only
 * break the cases where the author wanted the bare value. A task *name*, though, is
 * user input, and the one thing worth saying about it is where it must be quoted: a
 * script author writing `-Ticket "${taskName}"` gets what they expect, and one
 * writing it bare gets whatever the shell makes of a space.
 */
export function substitutePlaceholders(
  command: string,
  values: CommandPlaceholders,
): Substitution {
  const used: string[] = [];
  const unknown: string[] = [];
  const missing: string[] = [];

  const substituted = command.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const known = KNOWN.find((candidate) => candidate === name);
    if (!known) {
      if (!unknown.includes(name)) unknown.push(name);
      return whole;
    }
    const value = values[known];
    if (value === undefined) {
      if (!missing.includes(known)) missing.push(known);
      return whole;
    }
    if (!used.includes(known)) used.push(known);
    return value;
  });

  return { command: substituted, used, unknown, missing };
}
