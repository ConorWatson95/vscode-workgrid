/**
 * Commands that put a secret somewhere the harness will keep it.
 *
 * Measured 14 Aug 2026 across eight live pipelines: **150 recorded commands across
 * seven tasks carry an inline database password**, almost all of the form
 * `sqlcmd -S <host> -U <user> -P <password>`. That is not a transient exposure. The
 * harness records `SubtaskActivity.commands` **verbatim** — deliberately, because
 * that record is what makes worktree claims attributable and what a stage report
 * shows a reader — so every one of those passwords is sitting in `state.json`, in
 * whatever backups it has, and rendered into the reports a stage produces.
 *
 * ## Why this is the gate's business, when safety classification is not
 *
 * `permissionGatePolicy` deliberately refuses to replicate the CLI's "is this
 * command safe" classifier: that would mean maintaining a list of safe commands,
 * guessing at another tool's policy, and being wrong in the direction of blocking a
 * stage on `git status`. This is a different question and the distinction is what
 * makes it admissible. It does not ask whether the command is dangerous to *run* —
 * the CLI is welcome to that judgement. It asks whether running it writes a secret
 * into a file **this harness owns**, which is a fact about the harness's own
 * persistence and something no execution engine can know on its behalf.
 *
 * ## Denied, not held
 *
 * A hold waits for a human, and an unattended stage would simply stop. A denial
 * returns into the same turn with a reason the agent reads — verified mechanics,
 * see `stageInterjection` — so it re-issues the call in a form that does not leak.
 * The failure directions decide it: a wrong denial costs one round trip and a
 * reworded command, where a wrong allow persists a live credential indefinitely.
 *
 * ## What it deliberately does not cover
 *
 * Only the command line, never a file's contents. A stage noticed this immediately
 * when the rule was first exercised — refused at the shell, it observed it could
 * write the same string with the file tool instead — and the asymmetry is the point
 * rather than a hole. The harm being prevented is *the harness persisting a secret
 * it was never asked to keep*: `commands` are recorded verbatim, where a write
 * records only `pathsWritten`. A credential a project deliberately puts in a config
 * file is that project's business and lives under its own review; one that lands in
 * `state.json` because a stage happened to type it is the runtime's doing, and only
 * the runtime can prevent it.
 *
 * Narrow by construction, because a false positive here blocks real work:
 *
 * - A bare `-P` is **not** enough. `grep -P` is a Perl regex and nothing to do with
 *   passwords, and blocking it would be exactly the "wrong in the direction of
 *   blocking `git status`" failure the policy warns about. The flag only counts
 *   when the command also names a database client.
 * - A flag with no value is not an exposure. `-P` followed by another flag, or by
 *   nothing, is a prompt-for-password — the *safe* form, and the one the fix
 *   produces.
 * - An assignment is judged on its own, because a connection string carries its
 *   secret as `Password=…` regardless of which program is being run.
 *
 * Pure and vscode-free.
 */

/** Why a command was judged to expose a secret. */
export interface CredentialExposure {
  /** What matched, for the log and the agent's benefit — never the secret itself. */
  kind: "command-line password flag" | "inline password assignment";
}

/**
 * Programs that take a password as a command-line argument.
 *
 * Listed rather than inferred: the point is to keep `-P` from meaning "password"
 * everywhere, and a list of database clients is a much smaller and more stable
 * thing to maintain than a list of safe commands.
 */
const DATABASE_CLIENTS = /\b(sqlcmd|osql|bcp|psql|mysql|mysqldump|mongosh|redis-cli)\b/i;

/**
 * A password flag carrying an actual value.
 *
 * The value must not itself look like another flag: `sqlcmd -U me -P -Q "..."` is
 * the interactive form, which is the behaviour being encouraged, not caught.
 */
const PASSWORD_FLAG = /(^|\s)(-P|-p|--password|-Password)(\s+|=)(?!-)(\S)/;

/** `Password=…` / `PWD=…`, as a connection string or an environment assignment. */
const PASSWORD_ASSIGNMENT = /\b(password|pwd)\s*=\s*(?!\s|;|$)([^\s;"']|"[^"]|'[^'])/i;

/**
 * Judges one command, or undefined when nothing is exposed.
 *
 * Takes the command text alone: the caller has already decided this is a shell
 * tool, and a rule that needed to know which tool it was would not generalise to
 * the next engine's idea of running a process.
 */
export function findCredentialExposure(command: string): CredentialExposure | undefined {
  if (!command.trim()) return undefined;
  if (DATABASE_CLIENTS.test(command) && PASSWORD_FLAG.test(command)) {
    return { kind: "command-line password flag" };
  }
  if (PASSWORD_ASSIGNMENT.test(command)) {
    return { kind: "inline password assignment" };
  }
  return undefined;
}

/**
 * What the agent is told when a command is refused for exposing a secret.
 *
 * Carries no project knowledge — no tool name, no path, no profile convention.
 * That is the same line the protocol skill holds: the harness may say a secret must
 * not reach a command line, and only the repository can say which script resolves
 * one. Naming a project's tooling here would put engineering knowledge in the
 * runtime, and the next project would inherit advice about a script it does not
 * have.
 *
 * Says what to do instead in general terms, because a refusal with no route forward
 * is one the agent works around — which here means finding another way to pass the
 * same password.
 */
export function credentialExposureReason(exposure: CredentialExposure): string {
  return [
    `This call was refused because it carries a secret on the command line (${exposure.kind}).`,
    "",
    "Every command a stage runs is recorded verbatim in this task's durable state and",
    "is shown in its report, so a password passed this way is persisted and published",
    "rather than used and forgotten. Nothing has gone wrong with your work.",
    "",
    "Re-issue it without the secret. Use whatever this repository provides for",
    "resolving credentials — a wrapper script that reads a profile, an environment",
    "variable the process already has, or the tool's interactive prompt. If you cannot",
    "find one, say so in your report rather than passing the secret another way.",
  ].join("\n");
}
