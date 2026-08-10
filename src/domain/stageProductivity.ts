/**
 * Whether a stage that was supposed to change the codebase actually changed it.
 *
 * Every other defence against "the stage did not do its work" depends on the model
 * saying so: `BLOCKED`, `DEFERRED`, `CORRECTION-DECLINED`, a plan step accounted
 * `not done`. Each closed a real hole, and each has the same weakness — a stage that
 * declines in prose is recorded as done, because a session ending tidily is all
 * `finishSubtask(..., "done")` observes. The markers have now been widened five times
 * and the sixth case still slipped through: a stage produced an excellent root-cause
 * analysis, concluded the fix was out of scope for its route, said "Why I stopped" in
 * prose, and passed. The route advanced onto stages assuming a fix that did not exist.
 *
 * This is the one check that needs no cooperation. An implementation stage exists to
 * change files; a settled one that wrote none did not do its work, whatever its reply
 * says and whether or not it used a marker.
 *
 * Deliberately narrow, in three ways:
 *
 * - **Implementation stages only.** A review, a deployment, an assessment and a
 *   behaviour review all legitimately write nothing. Applying this to them would fire
 *   constantly, and a check that fires constantly is one people learn to approve
 *   through without reading.
 * - **Held, never failed.** The stage may be right — "there is nothing to change here"
 *   is a legitimate outcome, and the operator can approve in one click. What must not
 *   happen is the route advancing without anyone being told.
 * - **Writes, not commands.** A stage that only ran shell commands is exactly the case
 *   worth stopping on: read-only investigation reported as completed work.
 *
 * Pure and vscode-free.
 */

import { TaskStage } from "./taskPipeline";

/**
 * Whether this settled stage was meant to change files and did not.
 *
 * `pathsWritten` comes from the activity watcher, which records the file-writing tools
 * by name. A stage that wrote through a shell command instead — `git apply`, a
 * heredoc — is not counted as having written, and will be held. That is the right way
 * round: the point of the check is a stage that only looked, and asking a human to
 * glance at a stage that edited files unusually costs one click.
 */
export function changedNothing(stage: TaskStage): boolean {
  if (stage.kind !== "implementation") return false;
  // A stage that never ran cannot have failed to change anything.
  if (!stage.subtasks.some((subtask) => subtask.startedAt)) return false;
  // Absence of an activity record means *unmeasured*, not zero. A subtask that ran
  // before activity was recorded, or whose watcher produced nothing, tells us what it
  // did not do — and holding a stage on the strength of a missing measurement is the
  // same error as reporting a cost of zero for a session that reported none. The same
  // rule `stageUsage` follows for unmeasured runs.
  if (!stage.subtasks.some((subtask) => subtask.activity)) return false;
  // A declared check that ran and went green outranks this entirely. The whole reason
  // this exists is that a stage with no check is backed by nothing but its own account;
  // where something other than the agent has certified the work, an unusual way of
  // making the change is not the harness's business. See `stageEvidence`: verified beats
  // selfReported, and this is a substitute for the latter.
  if (stage.verification?.exitCode === 0) return false;
  return !stage.subtasks.some((subtask) => (subtask.activity?.pathsWritten?.length ?? 0) > 0);
}

/** How the hold explains itself, in the stage's `blocked` line. */
export const CHANGED_NOTHING_REASON =
  "this stage changed no files — if it was right that there was nothing to change, approve it";
