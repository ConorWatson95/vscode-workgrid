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
  };
}
