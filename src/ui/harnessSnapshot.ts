import { checklistGates, gateFor, itemsForGate } from "../domain/checklistScope";
import { isRetryable, sessionInFlight } from "../domain/harnessControl";
import { outstandingDeferrals } from "../domain/pipelineEngine";
import { pipelineRevision } from "../domain/pipelineRevision";
import { redactSecrets } from "../domain/secretRedaction";
import { stageEvidence, summariseEvidence } from "../domain/stageEvidence";
import { pipelineUsage, stageUsage } from "../domain/stageUsage";
import { ChecklistItem, TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { stagePresentation } from "./stagePresentation";
import { TaskGroupId, groupForTask, groupLabel } from "./taskGrouping";

/**
 * What a client other than the tree is shown about a run: plain JSON, derived on
 * every read from the task as persisted, and never stored anywhere.
 *
 * Built from the same derivations the tree uses — `stagePresentation` for a stage's
 * status words, `groupForTask` for which pile a task is in, `stageEvidence` for what
 * backs it — so two surfaces looking at one run cannot disagree about what it says.
 * A client that renders this is a view; nothing here decides anything.
 *
 * Summaries only. A stage's full report can run to tens of thousands of characters,
 * and a reply put into a conversation is read by a model, so the snapshot carries a
 * capped excerpt and the full text is a separate, explicit read.
 */

/** The seven shapes a stage row can take, for a client choosing a glyph. */
export type StageState =
  | "done"
  | "skipped"
  | "running"
  | "pending"
  | "failed"
  | "awaiting"
  | "held";

export interface RunSummary {
  taskId: string;
  name: string;
  route?: string;
  group: TaskGroupId;
  groupLabel: string;
  /** The stage the route is stopped at or working on, by name. */
  currentStage?: string;
  ticket?: string;
  updatedAt: string;
}

export interface ChecklistView {
  id: string;
  text: string;
  checked: boolean;
  /** Whether this item is what stops its gate — see `itemsForGate`. */
  holding: boolean;
  kind: "verify" | "action";
  note?: string;
  coveredBy?: string;
  checkedBy?: "check";
  raisedBy: string;
}

export interface StageView {
  id: string;
  name: string;
  kind: string;
  state: StageState;
  /** The tree's own words for the status, e.g. "Awaiting approval". */
  statusLabel: string;
  /** The tree's own detail, e.g. "2/3 · 1 critical". */
  detail: string;
  model?: string;
  modelsRun: string[];
  evidence: { basis: string; summary: string; selfReported: boolean };
  verification?: { command: string; exitCode: number; at: string };
  held?: string;
  failure?: string;
  subtasks: { title: string; status: string }[];
  costUsd: number;
  elapsedMs: number;
  /** Items a person answers at this stage: a gate's verification items, or the stage's own steps. */
  checklist: ChecklistView[];
  canApprove: boolean;
  canRetry: boolean;
  /** Why a visible action is not offered here, when that is not obvious. */
  actionNote?: string;
  /** The last thing the stage said, capped; the whole report is a separate read. */
  excerpt?: string;
}

export interface RunSnapshot extends RunSummary {
  branch: string;
  worktreePath: string;
  /** Passed back with any decision, so a write refuses if the run moved since. */
  revision: string;
  stages: StageView[];
  question?: { stageName: string; askedAt: string; live: boolean; items: string[] };
  deferrals: { id: string; text: string; raisedBy: string }[];
  evidenceLine?: string;
  /** Name of a stage with a session running right now, if any. */
  inFlight?: string;
  costUsd: number;
  discardedCostUsd: number;
}

export const EXCERPT_CHARS = 1_200;

export function summariseRun(task: TaskWorkspace): RunSummary {
  // Held tool calls live in the extension's own inbox, outside the state file, so a
  // client reading the file alone cannot see them. Counted as none; the cost is that
  // a task stopped only on a held call reads as its route position says rather than
  // as needing you.
  const group = groupForTask({
    status: task.status,
    pipeline: task.pipeline,
    heldCalls: 0,
    feedback: task.externalFeedback,
  });
  return {
    taskId: task.id,
    name: task.name,
    route: task.pipeline?.routeLabel ?? task.pipeline?.routeId,
    group,
    groupLabel: groupLabel(group),
    currentStage: currentStage(task.pipeline)?.name,
    ticket: task.origin?.ref,
    updatedAt: task.updatedAt,
  };
}

/**
 * The run a dashboard opens on when none is named: the most recently touched task
 * that has a route and needs somebody, else the most recently touched with a route.
 */
export function defaultRun(tasks: readonly TaskWorkspace[]): TaskWorkspace | undefined {
  const routed = tasks
    .filter((task) => task.pipeline && task.status !== "archived")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return routed.find((task) => summariseRun(task).group === "needs-you") ?? routed[0];
}

export function snapshotRun(task: TaskWorkspace): RunSnapshot {
  const pipeline = task.pipeline;
  const summary = summariseRun(task);
  const stages = pipeline ? pipeline.stages : [];
  const running = pipeline ? sessionInFlight(pipeline) : undefined;
  const usage = pipeline ? pipelineUsage(pipeline) : undefined;
  const discarded = (pipeline?.discarded ?? []).reduce((sum, run) => sum + (run.costUsd ?? 0), 0);

  return {
    ...summary,
    branch: task.branchName,
    worktreePath: task.worktreePath,
    revision: pipelineRevision(pipeline),
    stages: pipeline ? stages.map((stage) => stageView(pipeline, stage, running)) : [],
    question: pipeline?.pendingQuestion && {
      stageName: pipeline.pendingQuestion.stageName,
      askedAt: pipeline.pendingQuestion.askedAt,
      live: !!pipeline.pendingQuestion.liveCallId,
      items: pipeline.pendingQuestion.items
        .filter((item) => !item.answer)
        .map((item) => item.text),
    },
    deferrals: pipeline
      ? outstandingDeferrals(pipeline).map((item) => ({
          id: item.id,
          text: item.text,
          raisedBy: item.raisedByStageName,
        }))
      : [],
    evidenceLine: pipeline ? summariseEvidence(pipeline) : undefined,
    inFlight: running?.name,
    // `pipelineUsage` already includes what was discarded; the two are shown apart.
    costUsd: usage?.costUsd ?? 0,
    discardedCostUsd: discarded,
  };
}

function stageView(
  pipeline: TaskPipeline,
  stage: TaskStage,
  running: TaskStage | undefined,
): StageView {
  const holding = new Set(itemsForGate(pipeline, stage.id).map((item) => item.id));
  const visual = stagePresentation(stage, holding.size);
  const usage = stageUsage(stage);
  const evidence = stageEvidence(stage);
  const checklist = checklistFor(pipeline, stage, holding);

  const canApprove = stage.status === "awaiting-approval" && !running;
  const canRetry = isRetryable(stage) && !running;
  const outstanding = checklist.filter((item) => item.holding);

  return {
    id: stage.id,
    name: stage.name,
    kind: stage.kind,
    state: stateOf(stage, visual.contextValue),
    statusLabel: visual.label,
    detail: withoutLabel(visual.description, visual.label),
    model: stage.model,
    modelsRun: usage.models,
    evidence: { basis: evidence.basis, summary: evidence.summary, selfReported: evidence.selfReported },
    verification: stage.verification,
    held: stage.blocked?.trim() || undefined,
    failure: stage.subtasks.find((s) => s.status === "failed" && s.failureReason)?.failureReason,
    subtasks: stage.subtasks.map((s) => ({ title: s.title, status: s.status })),
    costUsd: usage.costUsd,
    elapsedMs: usage.elapsedMs,
    checklist,
    canApprove,
    canRetry,
    actionNote:
      running && (stage.status === "awaiting-approval" || isRetryable(stage))
        ? `A session is running on "${running.name}"; decisions wait until it stops.`
        : canApprove && outstanding.length > 0
          ? `${outstanding.length} item(s) must be ticked before this can be approved.`
          : undefined,
    excerpt: excerptOf(stage),
  };
}

/**
 * A gate is answered by the items routed to it, wherever they were raised — a gate
 * raises none of its own. Any other stage shows only the steps it asked a person to
 * take, since its verification items belong to a gate further on.
 */
function checklistFor(
  pipeline: TaskPipeline,
  stage: TaskStage,
  holding: ReadonlySet<string>,
): ChecklistView[] {
  if (stage.kind === "humanVerification") {
    const gates = checklistGates(pipeline);
    return pipeline.stages
      .filter((s) => s.status !== "skipped")
      .flatMap((s) => s.checklist ?? [])
      .filter((item) => !item.retired && (item.kind ?? "verify") === "verify")
      .filter((item) => gateFor(gates, item.scope)?.stageId === stage.id)
      .map((item) => itemView(item, holding));
  }
  return (stage.checklist ?? [])
    .filter((item) => item.kind === "action")
    .map((item) => itemView(item, new Set(item.checked ? [] : [item.id])));
}

function itemView(item: ChecklistItem, holding: ReadonlySet<string>): ChecklistView {
  return {
    id: item.id,
    text: item.text,
    checked: item.checked,
    holding: holding.has(item.id),
    kind: item.kind ?? "verify",
    note: item.note,
    coveredBy: item.coveredBy,
    checkedBy: item.checkedBy,
    raisedBy: item.raisedByStage,
  };
}

function stateOf(stage: TaskStage, contextValue: string): StageState {
  if (contextValue.split(" ").includes("stage-failed")) return "failed";
  switch (stage.status) {
    case "passed":
      return "done";
    case "skipped":
      return "skipped";
    case "active":
      return "running";
    case "awaiting-approval":
      return stage.blocked?.trim() ? "held" : "awaiting";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
  }
}

function currentStage(pipeline: TaskPipeline | undefined): TaskStage | undefined {
  if (!pipeline) return undefined;
  return (
    pipeline.stages.find((s) => s.id === pipeline.currentStage) ??
    pipeline.stages.find((s) => s.status !== "passed" && s.status !== "skipped")
  );
}

function excerptOf(stage: TaskStage): string | undefined {
  const raw = [...stage.subtasks].reverse().find((s) => s.reply?.trim())?.reply?.trim();
  if (!raw) return undefined;
  // Redacted for `formatStageReport`'s reason: capture-time masking cannot help a
  // task recorded by an earlier build, and this text is put in front of someone.
  const reply = redactSecrets(raw);
  if (reply.length <= EXCERPT_CHARS) return reply;
  // Announced, for the reason truncated command output is: a reply that simply
  // stops reads as the stage having stopped.
  return `${reply.slice(0, EXCERPT_CHARS).trimEnd()}\n\n… (${reply.length - EXCERPT_CHARS} more characters in the full report)`;
}

/**
 * The tree's description repeats the status first, because a tree row shows no
 * label beside it; next to the label it read "Awaiting approval · awaiting approval".
 */
function withoutLabel(description: string, label: string): string {
  const parts = description.split(" · ");
  return parts[0]?.trim().toLowerCase() === label.trim().toLowerCase()
    ? parts.slice(1).join(" · ")
    : description;
}
