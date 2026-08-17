/**
 * How often a human had to touch a route, and what for.
 *
 * The harness's stated goal is throughput per engineer rather than time to finish
 * one task, and that number is only meaningful against how much supervision each
 * task cost. Everything else worth measuring — cost, tokens, stage latency — is
 * already derivable from what a run persists. This is not: approving a gate,
 * answering a question, granting a refused permission and settling a deferral are
 * all recorded as different things in different places, and nothing counted them.
 *
 * Recorded as events rather than a running total, because "twelve interventions"
 * does not say whether the route is asking too many questions or failing too
 * often, and those have opposite fixes.
 */
export type InterventionKind =
  | "approval"
  | "answer"
  | "permission"
  | "deferral"
  | "revert"
  | "skip"
  | "retry"
  /**
   * The operator spoke to a stage while it was running.
   *
   * Its own kind rather than folded into "answer", because the two say opposite
   * things about the route. An answer is the stage asking and the operator
   * supplying — the mechanism working. An interjection is the operator having to
   * intervene *unprompted*, because the stage was confidently going the wrong way
   * and had not thought to ask. A route accumulating these is one whose stages are
   * under-briefed, which is a different fix from one that asks too much.
   */
  | "interjection";

export interface InterventionRecord {
  kind: InterventionKind;
  /** Stage the human acted on, when the action belonged to one. */
  stageId?: string;
  /** ISO timestamp, from the caller's clock — nothing here reads the wall clock. */
  at: string;
}

export interface InterventionSummary {
  total: number;
  /** Count per kind, absent kinds omitted. */
  byKind: Partial<Record<InterventionKind, number>>;
  /** Stages ranked by how much attention they needed, worst first. */
  byStage: { stageId: string; count: number }[];
  /** The most-touched stage, when one stands out. */
  worstStage?: { stageId: string; count: number };
}

export function appendIntervention(
  existing: readonly InterventionRecord[] | undefined,
  record: InterventionRecord,
): InterventionRecord[] {
  return [...(existing ?? []), record];
}

export function summariseInterventions(
  records: readonly InterventionRecord[] | undefined,
): InterventionSummary {
  const all = records ?? [];
  const byKind: Partial<Record<InterventionKind, number>> = {};
  const perStage = new Map<string, number>();

  for (const record of all) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    if (record.stageId) {
      perStage.set(record.stageId, (perStage.get(record.stageId) ?? 0) + 1);
    }
  }

  const byStage = [...perStage.entries()]
    .map(([stageId, count]) => ({ stageId, count }))
    // Ties broken by stage id so the order is stable across reads — an unstable
    // ranking in a report reads as the numbers having changed when they have not.
    .sort((a, b) => b.count - a.count || a.stageId.localeCompare(b.stageId));

  return {
    total: all.length,
    byKind,
    byStage,
    ...(byStage.length > 0 ? { worstStage: byStage[0] } : {}),
  };
}
