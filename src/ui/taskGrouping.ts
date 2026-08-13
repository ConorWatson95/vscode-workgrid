import { checklistGates, gateFor, itemsForGate } from "../domain/checklistScope";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";

/**
 * Which bucket a task belongs in, so a list of them can be scanned rather than
 * sifted.
 *
 * Grouped by what a task *needs* rather than by which stage it is on. A route can
 * have seventeen stages, so grouping by stage name produces mostly groups of one —
 * more to read, not less. The question actually being asked of the list is "what
 * do I have to do?".
 *
 * The one thing that question turned out to hide is **ownership**. A gate whose
 * checklist items are exercised by testers on DEV, or by an external party accepting
 * UAT, is not work the operator can do at all — the task has left them until feedback
 * arrives. Filed under "needs you" it padded the list they scan to decide what to pick
 * up next with rows they cannot clear, which is the sifting problem this module exists
 * to prevent, one level in. So a gate declaring `checklistAudience: "others"` and
 * holding outstanding items gets its own group.
 *
 * The rule keys off *outstanding items*, not the stage kind: an external gate with
 * everything ticked is a decision the operator makes, and belongs back in "needs you".
 *
 * Pure, so the rule is unit-tested. It has to be: the failure that matters is a
 * task that needs attention being filed under something the reader skips.
 */

export type TaskGroupId =
  /** Stopped, and only a person can move it. */
  | "needs-you"
  /** An agent is working on it right now. */
  | "working"
  /** Stopped at a gate somebody else has to answer: testers, or a UAT acceptor. */
  | "waiting-others"
  /** Has a route, nothing running, nothing waiting on a person. */
  | "parked"
  /** Every stage resolved. */
  | "done"
  /** No route at all — a chat task. */
  | "no-route"
  /** Archived, shown only when archived tasks are being shown. */
  | "archived";

/** Display order, worst-first: what needs doing is read before what does not. */
export const GROUP_ORDER: readonly TaskGroupId[] = [
  "needs-you",
  "working",
  "waiting-others",
  "parked",
  "done",
  "no-route",
  "archived",
];

export function groupLabel(id: TaskGroupId): string {
  switch (id) {
    case "needs-you":
      return "Needs you";
    case "working":
      return "Working";
    case "waiting-others":
      return "Waiting on others";
    case "parked":
      return "Parked";
    case "done":
      return "Done";
    case "no-route":
      return "No route";
    case "archived":
      return "Archived";
  }
}

/** Groups that start open, because their contents are the point of the view. */
export function groupStartsExpanded(id: TaskGroupId): boolean {
  return id === "needs-you" || id === "working";
}

export interface GroupInput {
  /** The task's own status, so an archived one is never filed by its route. */
  status: string;
  pipeline?: TaskPipeline;
  /** Tool calls the agent is blocked on right now. Live, not persisted. */
  heldCalls: number;
}

/**
 * The gate this task is stopped at, if somebody other than the operator answers it.
 *
 * Three outcomes rather than two, and the third is the one a first attempt got wrong.
 * Items are counted **per gate** via `itemsForGate`, never pipeline-wide, so a task is
 * not filed as waiting on testers over an item belonging to a gate two rows further on:
 *
 * - **Something outstanding** → waiting on others. The plain case.
 * - **Items exist and every one is ticked** → *yours*. Somebody has fed back and what is
 *   left is the approval, which only the operator can give.
 * - **No items at all** → waiting on others, which is the correction. Keying purely on
 *   outstanding items read an empty checklist as an answered one, so a DEV sign-off that
 *   raised nothing — or whose items predate scoping and route elsewhere — sat in "needs
 *   you" with nothing for the operator to read. Absence of a checklist is not evidence
 *   that a verification happened; the audience says who performs it, and nobody has.
 */
export function externalGate(pipeline: TaskPipeline | undefined): TaskStage | undefined {
  if (!pipeline) return undefined;

  const gate =
    pipeline.stages.find(
      (stage) => stage.kind === "humanVerification" && stage.status === "awaiting-approval",
    ) ??
    pipeline.stages.find(
      (stage) =>
        stage.kind === "humanVerification" &&
        (stage.status === "active" || stage.status === "pending"),
    );
  if (!gate || gate.checklistAudience !== "others") return undefined;

  if (itemsForGate(pipeline, gate.id).length > 0) return gate;

  // Nothing outstanding: was anything ever asked of this gate? A ticked item is somebody
  // having answered, and the approval that follows is the operator's.
  const answered = pipeline.stages
    .filter((stage) => stage.status !== "skipped")
    .flatMap((stage) => stage.checklist ?? [])
    .some((item) => item.checked && gateForItem(pipeline, item.scope) === gate.id);

  return answered ? undefined : gate;
}

/** Which gate answers for a scope, by id, so a ticked item can be attributed. */
function gateForItem(pipeline: TaskPipeline, scope: string | undefined): string | undefined {
  return gateFor(checklistGates(pipeline), scope)?.stageId;
}

function externalGateInPlay(pipeline: TaskPipeline | undefined): boolean {
  return externalGate(pipeline) !== undefined;
}

/**
 * When the current external gate started waiting, for display on the row.
 *
 * Moving these tasks out of the scan list is the point, but a delegated task is a
 * task you forget — testers do not notify the tree. The age is what keeps one that
 * has been sitting for a fortnight from looking the same as one handed over an hour
 * ago. Absent when the stage never recorded a start, which reads as unknown rather
 * than as new.
 */
export function externalWaitSince(pipeline: TaskPipeline | undefined): string | undefined {
  return externalGate(pipeline)?.startedAt;
}

/**
 * How long something has been waiting, in the units a reader of this group cares
 * about.
 *
 * Days and hours rather than the minutes-and-seconds a held tool call is measured in:
 * these waits are answered by other people on their own schedule, so a count of
 * seconds is precision about a number nobody acts on. `now` is passed in so the rule
 * is testable — nothing here calls the clock.
 */
export function formatWaitingSince(since: string, now: number): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return "waiting";

  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function groupForTask(input: GroupInput): TaskGroupId {
  if (input.status === "archived") return "archived";

  const stages = input.pipeline?.stages ?? [];
  if (stages.length === 0) return "no-route";

  // A held tool call outranks everything: the CLI is stopped mid-turn and only an
  // answer releases it, so this is the most urgent thing the list can show.
  if (input.heldCalls > 0) return "needs-you";

  const unanswered = (input.pipeline?.pendingQuestion?.items ?? []).filter(
    (item) => (item.answer ?? "").trim().length === 0,
  ).length;
  if (unanswered > 0) return "needs-you";

  const ungranted = (input.pipeline?.pendingDenials?.items ?? []).filter(
    (item) => !item.granted,
  ).length;
  if (ungranted > 0) return "needs-you";

  // A failed stage cannot resolve itself: someone has to fix the cause and re-open
  // it, so it is work for a person even though nothing is explicitly asking. Checked
  // before the external gate below, because a broken route is the operator's whatever
  // else the task is nominally waiting on.
  if (stages.some((stage) => stage.status === "failed")) return "needs-you";

  // Before the approval check, because an external gate is usually sitting at exactly
  // that status — and it is the reason this group exists.
  if (externalGateInPlay(input.pipeline)) return "waiting-others";

  if (stages.some((stage) => stage.status === "awaiting-approval")) return "needs-you";

  const current = stages.find(
    (stage) => stage.status === "active" || stage.status === "pending",
  );

  // Outstanding checklist items only count as needing attention once a
  // human-verification stage is the one in play. Raised earlier they are real but
  // not yet blocking, and treating them as urgent would put nearly every
  // harnessed task in this group — which is the sifting problem again.
  if (current?.kind === "humanVerification") {
    const outstanding = stages
      .filter((stage) => stage.status !== "skipped")
      .flatMap((stage) => stage.checklist ?? [])
      .filter((item) => !item.checked).length;
    if (outstanding > 0) return "needs-you";
    // A verification gate with nothing outstanding still waits on a person to
    // approve it, so it is theirs either way.
    return "needs-you";
  }

  if (stages.some((stage) => stage.status === "active")) return "working";
  if (!current) return "done";
  return "parked";
}

export interface Grouped<T> {
  id: TaskGroupId;
  label: string;
  items: T[];
}

/**
 * Buckets items in display order, dropping empty groups.
 *
 * Returns a single group undecorated when everything lands together: one wrapper
 * around one list is a level of nesting that hides tasks without organising
 * anything, and a repository with two tasks should look like a list.
 */
export function groupTasks<T>(
  items: readonly T[],
  groupOf: (item: T) => TaskGroupId,
): Grouped<T>[] {
  const buckets = new Map<TaskGroupId, T[]>();
  for (const item of items) {
    const id = groupOf(item);
    const existing = buckets.get(id);
    if (existing) existing.push(item);
    else buckets.set(id, [item]);
  }

  return GROUP_ORDER.filter((id) => buckets.has(id)).map((id) => ({
    id,
    label: groupLabel(id),
    items: buckets.get(id) ?? [],
  }));
}
