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
  /** Absolute path of the task's worktree. */
  worktreePath: string;
}

const KNOWN = ["taskName", "branch", "baseBranch", "worktreePath"] as const;

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

  const substituted = command.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const known = KNOWN.find((candidate) => candidate === name);
    if (!known) {
      if (!unknown.includes(name)) unknown.push(name);
      return whole;
    }
    if (!used.includes(known)) used.push(known);
    return values[known];
  });

  return { command: substituted, used, unknown };
}
