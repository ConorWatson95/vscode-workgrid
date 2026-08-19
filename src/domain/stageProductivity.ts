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

import { Subtask, TaskStage } from "./taskPipeline";

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

/**
 * Whether a correction subtask settled without changing anything and without saying so.
 *
 * `CORRECTION-DECLINED` is wired end to end — prompted for, parsed, and held on the
 * same machinery as `BLOCKED` — and it still depends on the model emitting it. On
 * `RenaultGB - MyRewards Summary` a plan correction carrying a genuine scope change
 * (a new column, a new source, a rewritten bucket rule) reasoned the case correctly
 * and at length — *"this is a scope change from what the plan documented, not a small
 * correction"* — wrote no files, and emitted no marker. The stage settled as passed
 * with the plan document unchanged, and the eight stages behind it then ran, cold or
 * amended, against a plan that still described the old requirement. Each of them said
 * so in prose too. The route advanced to the DEV promotion before anything failed.
 *
 * This is `changedNothing`'s argument applied one level in, and it needs no
 * cooperation for the same reason: a correction exists to change the stage's output,
 * so one that changed nothing did not correct anything, whatever its reply says.
 *
 * Narrow in four ways, each load-bearing:
 *
 * - **A correction, never an amendment.** *"Nothing in this stage's output changes"*
 *   is a correct and common amendment outcome — the nav/permissions stage in that same
 *   run reached it properly, and holding on it would fire on most of a cascade.
 * - **Any stage kind.** Unlike `changedNothing`, which is confined to implementation
 *   because a review legitimately writes nothing: a *correction* to a review rewrites
 *   its findings, and one to a plan rewrites the plan. Every medium
 *   `correctionMedium` names is a file.
 * - **Held, never failed.** The prompt explicitly permits "the finding was wrong — the
 *   code already does what it says is missing", which writes nothing and is correct.
 *   That is still a claim about a finding somebody raised, so it is worth one click.
 * - **Absence of activity means unmeasured, not zero**, the rule `stageUsage` and
 *   `changedNothing` both follow.
 *
 * Checked only when the reply carried no decline marker; a stage that declined
 * properly is already held, with a better reason than this one.
 */
export function correctionChangedNothing(subtask: Subtask): boolean {
  if (!subtask.correction || subtask.correction.upstream) return false;
  if (!subtask.activity) return false;
  return (subtask.activity.pathsWritten?.length ?? 0) === 0;
}

/** How that hold explains itself, in the stage's `blocked` line. */
export const CORRECTION_CHANGED_NOTHING_REASON =
  "the correction changed no files and did not decline — read what it said before " +
  "approving: a correction that neither fixes nor declines leaves every stage after " +
  "it built on the version the finding called wrong";
