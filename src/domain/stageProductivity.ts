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

import { Subtask, SubtaskActivity, TaskStage } from "./taskPipeline";

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
  // A stage whose work may not apply to a given change has no signal here at all.
  //
  // This check reads "wrote nothing" as "probably did not do its job", which holds only
  // where the stage was certainly supposed to write something. Some stages are
  // conditional by construction: a navigation-and-permissions stage matters only for a
  // brand-new report, and a UAT rework stage only when UAT found something. For those,
  // writing nothing is the *designed* outcome and this fires on every single run.
  //
  // Measured across 17 pipelines, 2 Sep 2026. `rc-nav-permissions` ran 38 times over 8
  // task instances, wrote zero files, and was held all 8 times — 23 of the 98 approvals
  // in the preceding week, every one of them clearing this hold. Four `*-uat-rework`
  // stages were held the same way. Its own intent said "if this change does not add a
  // new report, state that explicitly and move on", so the route and the runtime were
  // contradicting each other in writing.
  //
  // A check that fires on every run carries no information, and this file's own
  // narrowness rules exist because such a check is one people approve through without
  // reading. So the declaration supplies the missing precondition rather than switching
  // a check off: absent, nothing changes and every existing stage is judged exactly as
  // before.
  if (stage.conditional) return false;
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
  if (wroteOutsideTheWriteTools(subtask.activity)) return false;
  return (subtask.activity.pathsWritten?.length ?? 0) === 0;
}

/**
 * Whether this run could have written a file without `pathsWritten` recording it.
 *
 * `StageActivityWatcher` populates `pathsWritten` from `WRITE_TOOLS` alone — Write,
 * Edit, NotebookEdit — so a session that creates and edits files through the shell
 * records **none**, and an empty list then reads as a measured zero when it is
 * nothing of the kind. That is not a corner case here: of 251 settled subtasks in
 * one repository's state file since 25 Aug, **128 used only Bash or PowerShell and
 * recorded zero written paths**. A SQL implementation stage that wrote a whole
 * project directory with `printf`, `cat >>` and `[System.IO.File]::WriteAllText`
 * is indistinguishable, on this field, from one that did nothing.
 *
 * That was survivable while the consequence was a spurious hold costing a click.
 * It stopped being survivable when `pipelineRunner` began withdrawing the
 * downstream cascade on this answer: a correction that really did fix the code took
 * every stage behind it — the code review included — back to `passed`, so the fix
 * shipped unreviewed and the finding was marked dealt with. A false positive here
 * now costs exactly what the review existed to prevent, which is the opposite
 * disposition from the one this check was written under.
 *
 * So the honest answer for a shell-only run is *unmeasured*, the rule `stageUsage`
 * and the unmeasured-wait both follow: absence of measurement is not permission to
 * act. It does mean the hold cannot fire on the shell-driven stages that produce
 * most corrections — which is a real loss, and the reason the durable fix is to
 * measure the worktree rather than the tool calls. Until then, failing to hold a
 * correction that did nothing costs one click at the next gate; withdrawing a
 * review of a fix that did happen costs the review.
 *
 * Keyed on the tools this run actually used, never on the absence of write tools
 * alone: a session that used *no* tools at all wrote nothing by any route, and
 * excusing that would switch the check off for the case it was built for — a
 * correction that argued in prose and touched nothing.
 */
function wroteOutsideTheWriteTools(activity: SubtaskActivity): boolean {
  const counts = activity.toolCounts ?? {};
  return SHELL_TOOLS.some((tool) => (counts[tool] ?? 0) > 0);
}

/**
 * Tools that can write a file without the harness recording a path for it.
 *
 * Both, because gating only `Bash` is how the credential rule was first found to
 * miss: the CLI reaches for `PowerShell` and the check never sees the call.
 */
const SHELL_TOOLS = ["Bash", "PowerShell"] as const;

/** How that hold explains itself, in the stage's `blocked` line. */
export const CORRECTION_CHANGED_NOTHING_REASON =
  "the correction changed no files and did not decline — read what it said before " +
  "approving: a correction that neither fixes nor declines leaves every stage after " +
  "it built on the version the finding called wrong";
