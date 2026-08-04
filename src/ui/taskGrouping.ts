import { TaskPipeline } from "../domain/taskPipeline";

/**
 * Which bucket a task belongs in, so a list of them can be scanned rather than
 * sifted.
 *
 * Grouped by what a task *needs* rather than by which stage it is on. A route can
 * have seventeen stages, so grouping by stage name produces mostly groups of one —
 * more to read, not less. The question actually being asked of the list is "what
 * do I have to do?", and a task parked at UAT acceptance for a week answers it the
 * same way as one that has just stopped at a sign-off gate.
 *
 * Pure, so the rule is unit-tested. It has to be: the failure that matters is a
 * task that needs attention being filed under something the reader skips.
 */

export type TaskGroupId =
  /** Stopped, and only a person can move it. */
  | "needs-you"
  /** An agent is working on it right now. */
  | "working"
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

  if (stages.some((stage) => stage.status === "awaiting-approval")) return "needs-you";
  // A failed stage cannot resolve itself: someone has to fix the cause and re-open
  // it, so it is work for a person even though nothing is explicitly asking.
  if (stages.some((stage) => stage.status === "failed")) return "needs-you";

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
