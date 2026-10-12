import type { TaskPipeline } from "./taskPipeline";

/**
 * Tool calls the permission gate is holding open right now, as the state file shows
 * them to clients that do not hold them.
 *
 * The hold itself is a blocked hook in the process running the stage — VS Code or a
 * headless runner — and only that process can answer it. So a held call is mirrored
 * here by its owner, a client records a decision on the entry, and the owner, which
 * watches the file, applies it. The same shape live questions use
 * (`hostRequests.ts`), for the same reason: the answer must reach a process the
 * client cannot talk to.
 *
 * **A mirror, never the record.** The owner rewrites the list from what it is
 * actually holding every time that changes, so an entry exists exactly as long as
 * a call is waiting. A decision on an entry nobody holds any more is simply never
 * applied, and the next rewrite drops it.
 */
export interface HeldCall {
  /** The gate request id, which is how the owner finds the waiting hook. */
  id: string;
  tool: string;
  /** What the call would do, as the gate describes it. */
  detail: string;
  waitingSince: string;
  /** A client's decision, waiting for the owner to apply it. */
  decision?: HeldCallDecision;
}

/**
 * `once` answers this call; `session` also answers every matching call until the
 * process holding it exits. Adding a permission rule is deliberately absent: it
 * writes the project's settings, which is a change a client outside VS Code has no
 * business making on a tool call it saw for a few seconds.
 */
export interface HeldCallDecision {
  allow: boolean;
  scope: "once" | "session";
  at: string;
}

/** What the owner is holding for one task, in the shape it mirrors. */
export interface HeldCallSnapshot {
  id: string;
  tool: string;
  detail: string;
  waitingSince: string;
}

/**
 * The pipeline with its mirrored calls replaced by `waiting`, or `undefined` when
 * nothing changed — so an owner can rewrite on every change without writing the
 * state file when the list is the same.
 *
 * A decision already recorded on a call still waiting is kept: it is on its way to
 * being applied, and dropping it would make the operator decide twice.
 */
export function syncHeldCalls(
  pipeline: TaskPipeline,
  waiting: readonly HeldCallSnapshot[],
): TaskPipeline | undefined {
  const previous = pipeline.heldCalls ?? [];
  const byId = new Map(previous.map((call) => [call.id, call]));
  const next: HeldCall[] = waiting.map((call) => {
    const decision = byId.get(call.id)?.decision;
    return decision ? { ...call, decision } : { ...call };
  });
  if (sameCalls(previous, next)) return undefined;
  const { heldCalls: _dropped, ...rest } = pipeline;
  return next.length > 0 ? { ...rest, heldCalls: next } : rest;
}

/** Calls a client has decided and the owner has not yet applied. */
export function decidedHeldCalls(pipeline: TaskPipeline | undefined): HeldCall[] {
  return (pipeline?.heldCalls ?? []).filter((call) => call.decision);
}

function sameCalls(a: readonly HeldCall[], b: readonly HeldCall[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((call, index) => {
    const other = b[index];
    return (
      call.id === other.id &&
      call.tool === other.tool &&
      call.detail === other.detail &&
      call.waitingSince === other.waitingSince &&
      JSON.stringify(call.decision) === JSON.stringify(other.decision)
    );
  });
}

/**
 * Mirrored calls that are worth showing: only while a session is running, since a
 * process that died mid-hold never rewrote its list, and its entries describe hooks
 * that no longer exist.
 */
export function liveHeldCalls(pipeline: TaskPipeline | undefined): HeldCall[] {
  if (!pipeline?.heldCalls?.length) return [];
  const running = pipeline.stages.some((stage) => stage.subtasks.some((s) => s.status === "active"));
  return running ? pipeline.heldCalls : [];
}
