import { liveCallOf } from "../domain/hostRequests";
import { liveHeldCalls } from "../domain/heldCalls";
import { offeredCheckIds } from "../domain/checkCoverage";
import { checklistGates, gateFor, itemsForGate } from "../domain/checklistScope";
import { fatigueAdvice } from "../domain/correctionBrief";
import { isRetryable, sessionInFlight, stageFindings } from "../domain/harnessControl";
import {
  isCorrectable,
  outstandingDeferrals,
  outstandingPullRequests,
} from "../domain/pipelineEngine";
import { pipelineRevision } from "../domain/pipelineRevision";
import { redactSecrets } from "../domain/secretRedaction";
import { stageEvidence, summariseEvidence } from "../domain/stageEvidence";
import { sendBackTargets } from "../domain/stageRefresh";
import { pipelineUsage, stageUsage } from "../domain/stageUsage";
import { ChecklistItem, TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { activeStageLabel, stagePresentation } from "./stagePresentation";
import {
  TaskGroupId,
  externalGate,
  externalWaitSince,
  groupForTask,
  groupLabel,
} from "./taskGrouping";

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
  /** Where the ticket lives, when the source gave a link. */
  ticketUrl?: string;
  /** The task's brief, capped at `DESCRIPTION_CHARS`: what a row shows on hover. */
  description?: string;
  updatedAt: string;
  /** What the board says about this run in one line, and since when; see `attentionOf`. */
  attention: Attention;
  progress: { done: number; total: number };
  /** One state per stage, in route order, for the board's progress strip. */
  strip: StageState[];
}

/**
 * The one line a board row says about a run: what has to happen next and who does it.
 *
 * `need` is set only when the run is the operator's to move, phrased as the act —
 * "Approve …", "Answer 2 questions …" — because a board is scanned to decide what to
 * do, and a status ("awaiting approval") makes the reader translate it into one.
 * `since` is when that state began, so a row stuck for three days does not look like
 * one stuck for ten minutes.
 *
 * Mirrors `groupForTask`'s order exactly, branch for branch, so the line on a row
 * always describes the reason the row is in its group.
 */
export interface Attention {
  need?: string;
  /** Present-tense description when nothing is asked of the operator. */
  status: string;
  since?: string;
  /** Which colour the row carries: what kind of thing is being asked, or none. */
  tone: "ask" | "fail" | "act" | "run" | "wait" | "idle" | "done";
  /** The stage the row opens on: the one the attention is about. */
  stageId?: string;
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
  /** Of `modelsRun`, those the CLI could not price, so `costUsd` is not a measurement. */
  unpricedModels?: string[];
  evidence: { basis: string; summary: string; selfReported: boolean };
  verification?: { command: string; exitCode: number; at: string };
  held?: string;
  failure?: string;
  subtasks: { title: string; status: string }[];
  costUsd: number;
  elapsedMs: number;
  /** Items a person answers at this stage: a gate's verification items, or the stage's own steps. */
  checklist: ChecklistView[];
  /**
   * Checks this gate has recorded an outcome for — the only ones an item may be
   * attached to, since naming a check that never ran would read as unverified rather
   * than as the gap it is. Absent off a gate and before the gate's check has run.
   */
  checks?: { id: string; passed: boolean }[];
  canApprove: boolean;
  canRetry: boolean;
  /** Has output a correction can start from — **Fix This Stage**. */
  canCorrect: boolean;
  /** Has run, so it can be discarded and run again. */
  canRerun: boolean;
  /** Earlier stages the route lets this one send findings back to, nearest first. */
  sendBack?: {
    targets: { id: string; name: string; reopens: number; correctable: boolean }[];
    /** The stage recorded no reply, so the person supplies what went wrong. */
    needsFindings: boolean;
  };
  /** Said before another repair, once a stage has been repaired often enough to matter. */
  repairAdvice?: string;
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
  question?: {
    stageName: string;
    askedAt: string;
    live: boolean;
    items: string[];
    /** `items`' ids, in the same order, so answers can name what they answer. */
    itemIds: string[];
    /** Answered from outside VS Code and waiting for it to deliver. */
    submitted: boolean;
  };
  /**
   * The process advancing this route, as its lease records it. Not probed: the board
   * is re-read on every change, and asking the OS whether each holder is alive would
   * spawn a process per render. A crashed holder therefore still shows here until
   * housekeeping drops its lease (`Housekeeping.releaseDeadLeases`).
   */
  advancing?: { by: "vscode" | "headless"; pid: number; since: string; logPath?: string; stopRequested: boolean };
  /** Tool calls the running stage is blocked on, waiting for a person to allow or deny. */
  heldCalls: { id: string; tool: string; detail: string; since: string; decided: boolean }[];
  deferrals: { id: string; text: string; raisedBy: string }[];
  evidenceLine?: string;
  /** Name of a stage with a session running right now, if any. */
  inFlight?: string;
  costUsd: number;
  discardedCostUsd: number;
}

export const EXCERPT_CHARS = 1_200;
/** The board carries every run's brief, so a long one is cut rather than re-sent whole. */
export const DESCRIPTION_CHARS = 600;

export function summariseRun(task: TaskWorkspace): RunSummary {
  // Held calls are mirrored into the state file by the process holding them
  // (`domain/heldCalls.ts`); one already decided is on its way and needs nobody.
  const group = groupForTask({
    status: task.status,
    pipeline: task.pipeline,
    heldCalls: undecidedHeldCalls(task.pipeline).length,
    feedback: task.externalFeedback,
  });
  const stages = task.pipeline?.stages ?? [];
  return {
    taskId: task.id,
    name: task.name,
    route: task.pipeline?.routeLabel ?? task.pipeline?.routeId,
    group,
    groupLabel: groupLabel(group),
    currentStage: currentStage(task.pipeline)?.name,
    ticket: task.origin?.ref,
    ...(task.origin?.url ? { ticketUrl: task.origin.url } : {}),
    ...(task.description?.trim() ? { description: capDescription(task.description.trim()) } : {}),
    updatedAt: task.updatedAt,
    attention: attentionOf(task, group),
    progress: {
      done: stages.filter((s) => s.status === "passed" || s.status === "skipped").length,
      total: stages.length,
    },
    strip: stages.map((stage) =>
      stateOf(stage, stage.subtasks.some((s) => s.status === "failed") ? "stage-failed" : ""),
    ),
  };
}

export function attentionOf(task: TaskWorkspace, group: TaskGroupId): Attention {
  const pipeline = task.pipeline;
  const stages = pipeline?.stages ?? [];
  const quoted = (stage: { name: string }) => `“${stage.name}”`;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  if (group === "done") return { status: "All stages resolved", tone: "done" };
  if (!pipeline || stages.length === 0) return { status: "No route", tone: "idle" };

  if (group === "needs-you") {
    // First, as `groupForTask` ranks it: the CLI is stopped mid-turn on it.
    const held = undecidedHeldCalls(pipeline);
    if (held.length > 0) {
      const running = sessionInFlight(pipeline);
      return {
        need: `Allow or deny ${held[0].tool}${held.length > 1 ? ` and ${plural(held.length - 1, "more call")}` : ""}`,
        status: `${running?.name ?? "A stage"} is waiting for permission`,
        since: held[0].waitingSince,
        tone: "ask",
        stageId: running?.id,
      };
    }
    const question = pipeline.pendingQuestion;
    const unanswered = (question?.items ?? []).filter((i) => !(i.answer ?? "").trim()).length;
    if (question && unanswered > 0) {
      return {
        need: `Answer ${plural(unanswered, "question")} from ${quoted({ name: question.stageName })}`,
        status: `${question.stageName} is asking`,
        since: question.askedAt || undefined,
        tone: "ask",
        stageId: question.stageId,
      };
    }
    const denials = pipeline.pendingDenials;
    const ungranted = (denials?.items ?? []).filter((i) => !i.granted).length;
    if (denials && ungranted > 0) {
      return {
        need: `Grant or refuse ${plural(ungranted, "blocked call")} in ${quoted({ name: denials.stageName })}`,
        status: `${denials.stageName} is blocked`,
        since: denials.refusedAt,
        tone: "ask",
        stageId: denials.stageId,
      };
    }
    const failed = stages.find((s) => s.status === "failed");
    if (failed) {
      const at = failed.subtasks.find((s) => s.status === "failed")?.finishedAt ?? failed.finishedAt;
      return { need: `${quoted(failed)} failed — retry or fix`, status: "Failed", since: at, tone: "fail", stageId: failed.id };
    }
    const pr = outstandingPullRequests(pipeline)[0];
    if (pr) {
      const from = stages.find((s) => s.id === pr.stageId);
      return {
        need: `Merge the pull request${from ? ` from ${quoted(from)}` : ""}`,
        status: "Pull request open",
        since: pr.at,
        tone: "act",
        stageId: pr.stageId,
      };
    }
    const external = externalGate(pipeline);
    if (external) {
      return {
        need: `Read the reply on the ticket — ${quoted(external)}`,
        status: "Reply on the ticket",
        since: task.externalFeedback?.latest?.at ?? externalWaitSince(pipeline),
        tone: "act",
        stageId: external.id,
      };
    }
    const awaiting = stages.find((s) => s.status === "awaiting-approval");
    if (awaiting) {
      const items = itemsForGate(pipeline, awaiting.id).length;
      const need = awaiting.blocked?.trim()
        ? `Review why ${quoted(awaiting)} was held`
        : awaiting.kind === "humanVerification" && items > 0
          ? `Verify ${quoted(awaiting)} · ${plural(items, "item")}`
          : `Approve ${quoted(awaiting)}`;
      return { need, status: "Awaiting you", since: awaiting.finishedAt, tone: "act", stageId: awaiting.id };
    }
    const next = stages.find((s) => s.status === "pending");
    if (pipeline.lastAdvance) {
      return {
        need: next ? `Advance again — stopped before ${quoted(next)}` : "Advance again",
        status: pipeline.lastAdvance.reason === "exhausted" ? "Hit the step limit" : "Stopped",
        since: pipeline.lastAdvance.at,
        tone: "act",
        stageId: next?.id,
      };
    }
    return { need: next ? `Act on ${quoted(next)}` : "Needs you", status: "Needs you", tone: "act", stageId: next?.id };
  }

  if (group === "working") {
    const active = stages.find((s) => s.status === "active");
    const subtask = active?.subtasks.find((s) => s.status === "active");
    return {
      status: activeStageLabel(pipeline) ?? (active ? `${active.name}…` : "Working"),
      since: subtask?.startedAt ?? active?.startedAt,
      tone: "run",
      stageId: active?.id,
    };
  }

  if (group === "waiting-others") {
    const gate = externalGate(pipeline);
    return {
      status: gate ? `${gate.name} — with others` : "With others",
      since: externalWaitSince(pipeline),
      tone: "wait",
      stageId: gate?.id,
    };
  }

  const next = stages.find((s) => s.status === "pending");
  return { status: next ? `Next: ${next.name}` : "Idle", tone: "idle", stageId: next?.id };
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
      live: liveCallOf(pipeline, pipeline.pendingQuestion) !== undefined,
      items: pipeline.pendingQuestion.items
        .filter((item) => !item.answer)
        .map((item) => item.text),
      itemIds: pipeline.pendingQuestion.items.filter((item) => !item.answer).map((item) => item.id),
      submitted: !!pipeline.pendingQuestion.submittedAt,
    },
    heldCalls: liveHeldCalls(pipeline).map((call) => ({
      id: call.id,
      tool: call.tool,
      detail: call.detail,
      since: call.waitingSince,
      decided: !!call.decision,
    })),
    advancing: pipeline?.runLease && {
      by: pipeline.runLease.by,
      pid: pipeline.runLease.pid,
      since: pipeline.runLease.acquiredAt,
      ...(pipeline.runLease.logPath ? { logPath: pipeline.runLease.logPath } : {}),
      stopRequested: !!pipeline.stopRequestedAt,
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
  const started = stage.status !== "pending" || stage.subtasks.some((s) => s.status !== "pending");
  const targets = started && !running ? sendBackTargets(pipeline, stage.id) : [];
  const index = pipeline.stages.indexOf(stage);

  return {
    id: stage.id,
    name: stage.name,
    kind: stage.kind,
    state: stateOf(stage, visual.contextValue),
    statusLabel: visual.label,
    detail: withoutLabel(visual.description, visual.label),
    model: stage.model,
    modelsRun: usage.models,
    ...(usage.unpricedModels.length > 0 ? { unpricedModels: usage.unpricedModels } : {}),
    evidence: { basis: evidence.basis, summary: evidence.summary, selfReported: evidence.selfReported },
    verification: stage.verification,
    held: stage.blocked?.trim() || undefined,
    failure: stage.subtasks.find((s) => s.status === "failed" && s.failureReason)?.failureReason,
    subtasks: stage.subtasks.map((s) => ({ title: s.title, status: s.status })),
    costUsd: usage.costUsd,
    elapsedMs: usage.elapsedMs,
    checklist,
    checks: checksOf(stage),
    canApprove,
    canRetry,
    canCorrect: !running && isCorrectable(stage),
    canRerun: !running && started,
    sendBack:
      targets.length > 0
        ? {
            targets: targets.map((target) => ({
              id: target.id,
              name: target.name,
              // Everything from the target to this stage goes, so the count is the price.
              reopens: index - pipeline.stages.indexOf(target) + 1,
              correctable: isCorrectable(target),
            })),
            needsFindings: !stageFindings(stage),
          }
        : undefined,
    repairAdvice: fatigueAdvice(stage),
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

function capDescription(text: string): string {
  return text.length <= DESCRIPTION_CHARS ? text : text.slice(0, DESCRIPTION_CHARS - 1).trimEnd() + "…";
}

function checksOf(stage: TaskStage): StageView["checks"] {
  if (stage.kind !== "humanVerification") return undefined;
  const offered = offeredCheckIds(stage).map((outcome) => ({ id: outcome.id, passed: outcome.passed }));
  return offered.length > 0 ? offered : undefined;
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

function undecidedHeldCalls(pipeline: TaskWorkspace["pipeline"]) {
  return liveHeldCalls(pipeline).filter((call) => !call.decision);
}
