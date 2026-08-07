import { TaskPipeline } from "./taskPipeline";

/**
 * Which side of a comparison a run is on.
 *
 * CLAUDE.md has said for weeks that handoff-versus-rediscovery is "measurable but
 * not yet measured". The numbers to measure it with have existed since cost, tokens,
 * actual model and interventions started being recorded — what was missing was any
 * way to run the *other* arm, and any record of which arm a run had been.
 *
 * Both halves matter, and the second is the one that would have quietly ruined the
 * experiment: two finished tasks with different totals say nothing unless something
 * durable records that one had handoffs suppressed. That fact cannot live in a
 * session, a window, or somebody's memory of what they set last Tuesday.
 *
 * Deliberately not a global setting. A setting is read at the moment a stage runs,
 * so flipping it mid-route produces a run that was half of each — the one outcome
 * that is neither arm and cannot be discarded by looking at it.
 */

/** The one comparison this exists for, named so a stored arm is self-describing. */
export const HANDOFF_EXPERIMENT = "handoffs";

export interface PipelineExperiment {
  /** What is being varied. `HANDOFF_EXPERIMENT` for the handoff comparison. */
  id: string;
  /**
   * Which side this run is. `control` behaves exactly as the harness normally does;
   * every other arm changes something, and each is interpreted by name below.
   */
  arm: "control" | "no-handoffs";
  /** When it was set, so a run whose arm changed mid-route is visible afterwards. */
  at: string;
  /** Anything the operator wants to record about the conditions. */
  note?: string;
}

/**
 * Whether this run withholds handoffs from later stages.
 *
 * The suppression is at the point of *delivery*, not of recording: a stage still
 * writes its `HANDOFF:` block and the pipeline still stores it. Two reasons, and the
 * second is the important one — the arms stay comparable on what the stages actually
 * did, and the run remains readable afterwards rather than being an experiment that
 * destroyed its own evidence.
 */
export function handoffsSuppressed(pipeline: TaskPipeline | undefined): boolean {
  return pipeline?.experiment?.arm === "no-handoffs";
}

/** One line describing the arm, for a report that must not be read as a normal run. */
export function describeExperiment(
  experiment: PipelineExperiment | undefined,
): string | undefined {
  if (!experiment) return undefined;
  if (experiment.arm === "control") {
    return `Experiment \`${experiment.id}\`, control arm — the harness behaved normally.`;
  }
  return (
    `Experiment \`${experiment.id}\`, arm \`${experiment.arm}\` — handoffs were ` +
    "recorded but withheld from later stages, so each stage rediscovered what it needed."
  );
}
