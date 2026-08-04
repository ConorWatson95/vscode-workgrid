/**
 * Pipeline state: the *live* half of the harness. A pipeline is a route
 * instantiated against one task — same stage order, plus the subtasks a
 * planning agent produced and the outcome of each.
 *
 * Everything here is plain JSON so it round-trips through the task repository
 * untouched. All transitions live in ./pipelineEngine and are pure.
 */

import { StageKind } from "./taskRoute";

export type TaskStageStatus =
  | "pending"
  | "active"
  /** Every subtask resolved, held at a human gate. */
  | "awaiting-approval"
  | "passed"
  | "failed"
  | "skipped";

export type SubtaskStatus = "pending" | "active" | "done" | "failed" | "skipped";

/**
 * One unit of agent work. Subtasks are stages-within-a-worktree: they share the
 * parent task's worktree and branch, and each gets its own agent session. That
 * session boundary is the point — a subtask starts with a clean context and a
 * single objective instead of inheriting everything before it.
 */
export interface Subtask {
  /** Unique within the pipeline. */
  id: string;
  title: string;
  /** The prompt handed to the agent session for this subtask. */
  prompt: string;
  /** Optional slash-command to invoke instead of sending `prompt` as text. */
  workflow?: string;
  status: SubtaskStatus;
  /** Agent session that ran (or is running) this subtask, once known. */
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Set when status is "failed" — why it failed, for display and retry. */
  failureReason?: string;
  /**
   * What the agent said at the end, kept verbatim.
   *
   * A stage session is otherwise invisible: the reply was parsed for a marker and
   * then discarded, so a preview that produced pages of output left nothing to
   * look at and had to be run again by hand to be seen.
   */
  reply?: string;
  /** What the subtask actually did: tools, commands, files, output. */
  activity?: SubtaskActivity;
}

/**
 * A record of what one subtask did.
 *
 * Deliberately a summary rather than a transcript: this lives in the task state
 * file, which is read and rewritten whole on every update, so an unbounded
 * transcript here would make every later write more expensive. See
 * `agents/stageActivity.ts` for what is kept and why.
 */
export interface SubtaskActivity {
  /** Tool name to call count. */
  toolCounts?: Record<string, number>;
  /** Shell commands run, verbatim, so a wrong flag is visible afterwards. */
  commands?: string[];
  pathsWritten?: string[];
  pathsRead?: string[];
  /** Command output, capped. */
  output?: string;
}

/**
 * Something the operator said when approving a stage.
 *
 * The gate is the moment a human has just read what a stage produced and knows
 * something the route does not — "deploy only this project", "skip the Motability
 * variant". Without somewhere to put it, acting on it meant editing the brief or
 * re-running a stage, so the knowledge was either lost or expensive.
 */
export interface GuidanceNote {
  id: string;
  /** Stage that was being approved, so the note can be attributed. */
  stageId: string;
  stageName: string;
  text: string;
  at: string;
}

/**
 * One thing a human must verify. Produced by behaviour-review stages and
 * consumed at the human-verification gate — this is the evidence a task must
 * present before it can be called complete.
 */
export interface ChecklistItem {
  id: string;
  /** What to exercise, and what would indicate a regression. */
  text: string;
  checked: boolean;
  /** Stage that raised it, so the gate can explain where each item came from. */
  raisedByStage: string;
  /** Optional tester note, e.g. what they actually observed. */
  note?: string;
  checkedAt?: string;
}

export interface TaskStage {
  /** Mirrors RouteStageDefinition.id. */
  id: string;
  name: string;
  kind: StageKind;
  status: TaskStageStatus;
  /** Copied from the route so a persisted pipeline is self-describing. */
  intent: string;
  splittable: boolean;
  requiresApproval: boolean;
  /**
   * Set on stages that produce or consume verification items. A behaviour
   * review writes them; the human-verification gate collects every outstanding
   * one and cannot be approved while any remain unchecked.
   */
  checklist?: ChecklistItem[];
  /** Why this stage exists, when it was appended by a rule rather than a route. */
  addedByRule?: string;
  /**
   * Model for this stage's sessions, copied from the route so a persisted
   * pipeline stays self-describing. Undefined means the configured default.
   */
  model?: string;
  /**
   * Empty on a splittable stage means "not yet planned". Non-splittable stages
   * are created with exactly one synthesized subtask, so every runnable stage
   * has a uniform shape.
   */
  subtasks: Subtask[];
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskPipeline {
  /** Route this pipeline was instantiated from. */
  routeId: string;
  /**
   * The route's label at creation time. Stored rather than looked up because a
   * route may be defined by the project and later renamed or removed; a
   * persisted pipeline must stay readable regardless.
   */
  routeLabel?: string;
  stages: TaskStage[];
  /** Stage currently active or awaiting approval; absent when at rest. */
  currentStage?: string;
  /**
   * A stage's outstanding question, held until it is answered.
   *
   * Persisted rather than shown and forgotten. A question is the one thing in a
   * route that cannot be recovered by re-reading state: the session that asked
   * it is gone, so a dialog dismissed by accident used to mean re-running the
   * stage just to see what it wanted. It also has to survive several tasks
   * asking at once, which a modal cannot.
   */
  pendingQuestion?: PendingQuestion;
  /**
   * Tool calls the permission layer refused, held until dealt with.
   *
   * Persisted for the same reason questions are: a notification is transient and
   * several tasks produce a pile of them, so dismissing one lost the only record
   * of what was refused and which rule would fix it.
   */
  pendingDenials?: PendingDenials;
  /**
   * What the operator told the route while approving stages, oldest first.
   *
   * Cumulative and handed to every later stage, because guidance given at one gate
   * is usually about the work that follows — "deploy only this project" has to
   * survive past the next stage to be worth anything.
   */
  guidance?: GuidanceNote[];
}

/** Refusals from one stage, waiting on a decision. */
export interface PendingDenials {
  stageId: string;
  stageName: string;
  subtaskId: string;
  refusedAt: string;
  items: DenialItem[];
}

/** One refused call, and the rule that would permit it. */
export interface DenialItem {
  id: string;
  /** Tool that was refused, e.g. "PowerShell". */
  tool: string;
  command?: string;
  /** The permission layer's own words. */
  reason: string;
  /** How many times the agent retried this same call. */
  attempts: number;
  /** Suggested `permissions.allow` entry, when one could be derived. */
  rule?: string;
  /** Set once the rule has been written, so the panel shows what is left. */
  granted?: boolean;
}

/**
 * A stage waiting on answers from a human.
 *
 * Holds the questions as separate items rather than one block of text. A stage
 * that needs three things asks for three things, and pairing each answer with
 * the question it belongs to is what lets the brief record them unambiguously —
 * a single field for five questions produces one answer that addresses whichever
 * the user happened to read.
 */
export interface PendingQuestion {
  stageId: string;
  stageName: string;
  subtaskId: string;
  askedAt: string;
  items: QuestionItem[];
  /**
   * Set when an agent is **blocked on this question right now**, waiting on the
   * `ask_user` tool.
   *
   * The difference it makes: answering a live question hands the answer straight
   * back to the waiting session, which continues mid-turn with everything it had
   * worked out. Answering a question without one enriches the brief and the
   * subtask runs again from the beginning.
   *
   * Persisted with the rest, but only meaningful while that CLI process lives —
   * so a stale one is expected after a reload and callers must treat "no longer
   * waiting" as normal rather than an error.
   */
  liveCallId?: string;
}

/** One question and, once given, its answer. */
export interface QuestionItem {
  id: string;
  text: string;
  answer?: string;
}

/**
 * Upgrades pipelines persisted by earlier versions, which stored only
 * `{ name, status }` stages and no routeId. Such records predate routes, so
 * they are treated as an unnamed ad-hoc route and given the fields the engine
 * needs. Returns undefined for absent input so callers can pass through.
 */
export function normalizePipeline(
  stored: unknown,
): TaskPipeline | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const raw = stored as Partial<TaskPipeline> & { stages?: unknown };
  if (!Array.isArray(raw.stages)) return undefined;

  const stages: TaskStage[] = raw.stages.map((entry, index) => {
    const stage = (entry ?? {}) as Partial<TaskStage> & { name?: string };
    const name = stage.name ?? `Stage ${index + 1}`;
    return {
      id: stage.id ?? `stage-${index + 1}`,
      name,
      // Records predating stage kinds described implementation work.
      kind: stage.kind ?? "implementation",
      status: stage.status ?? "pending",
      intent: stage.intent ?? name,
      splittable: stage.splittable ?? false,
      requiresApproval: stage.requiresApproval ?? false,
      checklist: Array.isArray(stage.checklist) ? stage.checklist : undefined,
      addedByRule: stage.addedByRule,
      model: stage.model,
      subtasks: Array.isArray(stage.subtasks) ? stage.subtasks : [],
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
    };
  });

  return {
    routeId: raw.routeId ?? "ad-hoc",
    routeLabel: raw.routeLabel,
    stages,
    currentStage: raw.currentStage,
    pendingQuestion: normalizeQuestion(raw.pendingQuestion),
    pendingDenials: normalizeDenials(raw.pendingDenials),
    guidance: normalizeGuidance(raw.guidance),
  };
}

/**
 * Keeps stored approval notes, dropping any that lost their text.
 *
 * Returns undefined rather than an empty array so a pipeline that never had
 * guidance round-trips unchanged.
 */
function normalizeGuidance(stored: unknown): GuidanceNote[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const notes = stored
    .filter(
      (note): note is GuidanceNote =>
        Boolean(note) && typeof note.text === "string" && note.text.trim().length > 0,
    )
    .map((note, index) => ({
      id: note.id ?? `g${index + 1}`,
      stageId: note.stageId ?? "",
      stageName: note.stageName ?? note.stageId ?? "",
      text: note.text.trim(),
      at: note.at ?? "",
    }));
  return notes.length > 0 ? notes : undefined;
}

/** Keeps stored refusals only when there is something actionable left. */
function normalizeDenials(stored: unknown): PendingDenials | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const d = stored as Partial<PendingDenials>;
  if (!d.stageId || !d.subtaskId || !Array.isArray(d.items)) return undefined;

  const items: DenialItem[] = d.items
    .filter((item): item is DenialItem => Boolean(item?.tool))
    .map((item, index) => ({
      id: item.id ?? `${d.subtaskId}-d${index + 1}`,
      tool: item.tool,
      command: item.command,
      reason: item.reason ?? "",
      attempts: typeof item.attempts === "number" ? item.attempts : 1,
      rule: item.rule,
      granted: item.granted === true,
    }));
  if (items.length === 0) return undefined;

  return {
    stageId: d.stageId,
    stageName: d.stageName ?? d.stageId,
    subtaskId: d.subtaskId,
    refusedAt: d.refusedAt ?? "",
    items,
  };
}

/**
 * Keeps a stored question only if it is complete enough to act on. A half-written
 * record would render an "answer this" prompt with nothing to answer.
 */
function normalizeQuestion(stored: unknown): PendingQuestion | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const q = stored as Partial<PendingQuestion> & { question?: string };
  if (!q.stageId || !q.subtaskId) return undefined;

  // Records written before questions were itemised held a single string.
  const items: QuestionItem[] = Array.isArray(q.items)
    ? q.items
        .filter((item): item is QuestionItem => Boolean(item?.text?.trim()))
        .map((item, index) => ({
          id: item.id ?? `${q.subtaskId}-q${index + 1}`,
          text: item.text,
          answer: item.answer,
        }))
    : q.question?.trim()
      ? [{ id: `${q.subtaskId}-q1`, text: q.question }]
      : [];
  if (items.length === 0) return undefined;

  return {
    stageId: q.stageId,
    stageName: q.stageName ?? q.stageId,
    subtaskId: q.subtaskId,
    askedAt: q.askedAt ?? "",
    items,
    liveCallId: typeof q.liveCallId === "string" ? q.liveCallId : undefined,
  };
}
