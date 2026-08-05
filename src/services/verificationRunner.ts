import { redactSecrets } from "../domain/secretRedaction";

/**
 * Runs a stage's verification command and reports what a process, rather than an
 * agent, says about the work.
 *
 * The interface is narrow on purpose: the runner's tests need no processes, and a
 * headless run supplies the same implementation as the extension. `services/` avoids
 * `vscode`, and this touches nothing but `child_process`.
 */

export interface CommandOutcome {
  exitCode: number;
  /** Combined stdout and stderr, redacted and capped. */
  output: string;
  /** Set when the command could not be started at all. */
  spawnError?: string;
}

export interface VerificationCommandRunner {
  run(
    command: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<CommandOutcome>;
}

/**
 * Kept output, in characters.
 *
 * Smaller than a stage's activity budget: a failing build's last lines are what
 * matter, and this is persisted as the stage's failure reason.
 */
export const MAX_VERIFY_OUTPUT = 4000;

/**
 * What a verification result means for the stage, as a sentence.
 *
 * Pure and exported so the wording is tested — this string becomes a stage's
 * failure reason, which is the only thing many readers will see.
 */
export function describeVerification(
  command: string,
  outcome: CommandOutcome,
): string {
  const safeCommand = redactSecrets(command);
  if (outcome.spawnError) {
    // Distinguished from a failing check: a command that could not start proves
    // nothing about the work, and treating it as a failed build sends someone
    // looking for a bug that is not there.
    return (
      `The stage's verification command could not be started: ${safeCommand}\n` +
      `${outcome.spawnError}\n\n` +
      `The stage is failed rather than passed, because nothing verified it — but ` +
      `fix the command, not the work.`
    );
  }
  return (
    `Verification failed (exit ${outcome.exitCode}): ${safeCommand}\n\n` +
    `${outcome.output || "(no output)"}`
  );
}

/** Trims and redacts captured output. Exported for the same reason. */
export function prepareOutput(text: string): string {
  const body = redactSecrets(text.trim());
  if (body.length <= MAX_VERIFY_OUTPUT) return body;
  // The tail, not the head: a build's error is at the end, and the top of a long
  // log is the part that says everything is fine so far.
  return (
    `…${(body.length - MAX_VERIFY_OUTPUT).toLocaleString("en-GB")} earlier characters omitted…\n` +
    body.slice(-MAX_VERIFY_OUTPUT)
  );
}
