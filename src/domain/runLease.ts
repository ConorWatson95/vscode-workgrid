import { ProbedProcess } from "./sessionProcesses";
import { TaskWorkspace } from "./taskWorkspace";

/**
 * Which process is driving a task's route, recorded in the state file.
 *
 * "Is this task advancing?" used to be answered only from the runner's own memory —
 * right while VS Code was the only thing that could run a stage, and wrong the moment
 * a headless runner exists. Two runners on one task each hold a whole pipeline for a
 * session at a time and merge it back afterwards; they would start the same subtask
 * twice, and the stale-subtask sweep in one would reclaim the other's live work as
 * abandoned. So the claim has to live where both can see it.
 *
 * **Liveness is probed, never heartbeated.** A heartbeat is a state-file write every
 * few seconds per running task, and that file is rewritten whole and re-parsed by
 * every window and board feed watching it — measured at 16MB on the repository this
 * runs against. The owner's pid plus the time its process started is enough: a dead
 * owner is gone, and a reused pid starts long after the lease was taken. Where the
 * platform cannot say when a process started the lease is kept, the direction the
 * session-process sweep already chooses — refusing a second runner costs a click,
 * admitting one costs a duplicated stage.
 *
 * **Same host only.** The state file lives under the git common dir of a local clone,
 * so a lease from another machine means a shared filesystem nobody here supports, and
 * a pid from there means nothing locally. It is treated as live.
 */
export interface RunLease {
  /** Which kind of client is driving. Display only; nothing decides on it. */
  by: "vscode" | "headless";
  pid: number;
  host: string;
  /** When the owning process started, so a reused pid is not mistaken for it. */
  processStartedAt: string;
  /** When this owner took the task. */
  acquiredAt: string;
  /** Where a headless runner writes its log, since nobody is watching its output. */
  logPath?: string;
}

export type LeaseOwner = Pick<RunLease, "pid" | "host" | "processStartedAt">;

/** The tolerance the session-process sweep uses, for the same comparison. */
export const LEASE_START_TOLERANCE_MS = 5 * 60_000;

export function sameOwner(a: LeaseOwner, b: LeaseOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.processStartedAt === b.processStartedAt;
}

/**
 * Whether a lease's owner is still running, given what the OS says about its pid.
 *
 * Undefined `probe` means the OS was not asked or did not answer, which is not
 * evidence of death.
 */
export function leaseOwnerAlive(
  lease: LeaseOwner,
  host: string,
  probe: ProbedProcess | undefined,
): boolean {
  if (lease.host !== host) return true;
  if (!probe) return true;
  if (!probe.alive) return false;
  const ours = Date.parse(lease.processStartedAt);
  const theirs = probe.osStartedAt === undefined ? NaN : Date.parse(probe.osStartedAt);
  if (Number.isFinite(ours) && Number.isFinite(theirs)) {
    return Math.abs(theirs - ours) <= LEASE_START_TOLERANCE_MS;
  }
  return true;
}

/**
 * Takes the task for `lease`'s owner, or returns undefined if somebody else holds it.
 *
 * `deadOwner` is the holder the caller probed and found gone; the lease is taken over
 * only if it is *still* that holder, because the probe ran outside the store's lock
 * and somebody else may have taken the task meanwhile. Re-taking a lease this owner
 * already holds succeeds, so a runner that advances twice in one process is fine.
 *
 * Synchronous, for `repository.update`.
 */
export function claimLease(
  task: TaskWorkspace | undefined,
  lease: RunLease,
  deadOwner?: LeaseOwner,
): TaskWorkspace | undefined {
  if (!task?.pipeline) return undefined;
  const held = task.pipeline.runLease;
  if (held && !sameOwner(held, lease) && !(deadOwner && sameOwner(held, deadOwner))) {
    return undefined;
  }
  return { ...task, pipeline: { ...task.pipeline, runLease: lease } };
}

/** Drops the lease if it is still this owner's; anything else is left alone. */
export function dropLease(
  task: TaskWorkspace | undefined,
  owner: LeaseOwner,
): TaskWorkspace | undefined {
  const held = task?.pipeline?.runLease;
  if (!task?.pipeline || !held || !sameOwner(held, owner)) return undefined;
  const { runLease: _released, ...pipeline } = task.pipeline;
  return { ...task, pipeline };
}

/**
 * Asks for a running route to stop, for a client that does not own it.
 *
 * Recorded rather than signalled because the owner may be another process; it reads
 * the request off the state file and cancels its own run. Only meaningful while a
 * lease is held — there is nothing to stop otherwise, and a request left lying around
 * would cancel the next run the moment it started.
 */
export function requestStop(task: TaskWorkspace | undefined, at: string): TaskWorkspace | undefined {
  if (!task?.pipeline?.runLease || task.pipeline.stopRequestedAt) return undefined;
  return { ...task, pipeline: { ...task.pipeline, stopRequestedAt: at } };
}

/** Whether a stop has been asked for since this owner took the task. */
export function stopRequested(task: TaskWorkspace | undefined, owner: LeaseOwner): boolean {
  const pipeline = task?.pipeline;
  if (!pipeline?.stopRequestedAt || !pipeline.runLease) return false;
  return (
    sameOwner(pipeline.runLease, owner) &&
    Date.parse(pipeline.stopRequestedAt) >= Date.parse(pipeline.runLease.acquiredAt)
  );
}

/** Clears a stop request once it has been honoured, or when a run ends. */
export function clearStop(task: TaskWorkspace | undefined): TaskWorkspace | undefined {
  if (!task?.pipeline?.stopRequestedAt) return undefined;
  const { stopRequestedAt: _done, ...pipeline } = task.pipeline;
  return { ...task, pipeline };
}
