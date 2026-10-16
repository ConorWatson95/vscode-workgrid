import { TaskPipeline } from "./taskPipeline";

/**
 * What a retry is told about the attempt a transport failure cut off.
 *
 * A transient failure reverts the subtask and runs it again, which is right: nothing
 * about the work has been judged. But it ran again *cold*, and a session that dies on
 * a 529 mid-turn has often already acted. The commands it ran were recorded and handed
 * to nobody, so a promotion stage that had pushed, or a deployment that had run its
 * scripts, was retried as though neither had happened. A tool error says the outcome
 * is unknown, not that nothing executed.
 *
 * The answer is information, not machinery: no journal and no idempotency layer, just
 * the commands, and an instruction to check what already took effect before repeating
 * anything that changes the world outside the worktree. Filed as stage-scoped guidance
 * for `formatRetryNote`'s reason — a second channel with the same meaning is one the
 * prompts cannot rank against the first — and stage-scoped because the note is true
 * only until that stage passes.
 *
 * Pure and vscode-free.
 */

/** Commands quoted, newest last. The tail is what the attempt was doing when it died. */
export const MAX_INTERRUPTED_COMMANDS = 20;
/** Per command, since one heredoc can be pages long and the head says what it was. */
export const MAX_COMMAND_CHARS = 300;

/**
 * The note for a retry, or undefined when the dead attempt ran no commands — then
 * there is nothing to reconcile, and a note saying so is noise on every outage.
 */
export function interruptedAttemptNote(
  subtaskTitle: string,
  cause: string,
  commands: readonly string[],
): string | undefined {
  const ran = commands.map((c) => c.trim()).filter((c) => c.length > 0);
  if (ran.length === 0) return undefined;

  const shown = ran.slice(-MAX_INTERRUPTED_COMMANDS);
  const omitted = ran.length - shown.length;
  const lines = shown.map((c) =>
    c.length > MAX_COMMAND_CHARS ? `- \`${c.slice(0, MAX_COMMAND_CHARS)}\` … (cut)` : `- \`${c}\``,
  );
  // Announced, the rule truncated output follows: a list that simply starts partway
  // through reads as the attempt having started there.
  const head =
    omitted > 0 ? [`(${omitted} earlier command(s) not shown; these are the last ${shown.length}.)`] : [];

  return (
    `An earlier attempt at "${subtaskTitle}" was cut off by a transport failure ` +
    `(${firstLine(cause)}) after it had run the commands below. Their effects may ` +
    "already be in place. Before repeating any command that changes something outside " +
    "the worktree — a push, a merge, a deployment, a database write — check whether it " +
    "already took effect, and do not repeat one that did. This is not a reason to change " +
    "approach: the attempt was not judged, only interrupted.\n\n" +
    [...head, ...lines].join("\n")
  );
}

/** Files the note as stage-scoped guidance. Returns the pipeline unchanged when there is no note. */
export function recordInterruptedAttempt(
  pipeline: TaskPipeline,
  stage: { id: string; name: string },
  subtaskId: string,
  note: string | undefined,
  at: string,
): TaskPipeline {
  if (!note) return pipeline;
  return {
    ...pipeline,
    guidance: [
      ...(pipeline.guidance ?? []),
      {
        id: `interrupted-${subtaskId}-${at}`,
        stageId: stage.id,
        stageName: stage.name,
        text: note,
        at,
        scope: "stage",
      },
    ],
  };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
