import * as os from "node:os";
import {
  LeaseOwner,
  RunLease,
  claimLease,
  clearStop,
  dropLease,
  leaseOwnerAlive,
  requestStop,
  sameOwner,
} from "../domain/runLease";
import { ProbedProcess } from "../domain/sessionProcesses";
import { TaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { probeProcesses } from "./sessionProcessRegistry";

export type LeaseResult =
  | { ok: true; task: TaskWorkspace }
  | { ok: false; heldBy?: RunLease; message: string };

/**
 * Takes and gives back the state-file claim on a task's route for this process
 * (`domain/runLease.ts`). One per process: the extension host and a headless runner
 * each build one with their own identity.
 */
export class RunLeaseService {
  private readonly host = os.hostname();
  private readonly owner: LeaseOwner;

  constructor(
    private readonly repository: TaskRepository,
    private readonly by: RunLease["by"],
    private readonly probe: (pids: readonly number[]) => Promise<ProbedProcess[]> = probeProcesses,
    identity: { pid: number; processStartedAt: string } = currentProcess(),
  ) {
    this.owner = { pid: identity.pid, host: this.host, processStartedAt: identity.processStartedAt };
  }

  get identity(): LeaseOwner {
    return this.owner;
  }

  /**
   * Takes the task, or reports who has it.
   *
   * A holder that has died is taken over — that is how a crashed runner stops
   * wedging its task — but only after the OS has been asked, since the alternative is
   * two runners on one route.
   */
  async acquire(taskId: string, at: string, logPath?: string): Promise<LeaseResult> {
    const current = await this.repository.get(taskId);
    if (!current?.pipeline) {
      return { ok: false, message: current ? "That task has no route." : "That task no longer exists." };
    }
    const held = current.pipeline.runLease;
    const dead = held && !sameOwner(held, this.owner) && !(await this.alive(held)) ? held : undefined;
    const lease: RunLease = {
      by: this.by,
      ...this.owner,
      acquiredAt: at,
      ...(logPath ? { logPath } : {}),
    };
    // A stop asked of the dead holder must not cancel this run the moment it starts.
    const taken = await this.repository.update(taskId, (task) => {
      const claimed = claimLease(task, lease, dead);
      return claimed && dead ? (clearStop(claimed) ?? claimed) : claimed;
    });
    if (taken) return { ok: true, task: taken };
    const holder = (await this.repository.get(taskId))?.pipeline?.runLease;
    return { ok: false, heldBy: holder, message: describeHolder(holder) };
  }

  /** Gives the task back, and clears any stop request it was answering. */
  async release(taskId: string): Promise<void> {
    await this.repository.update(taskId, (task) => {
      const dropped = dropLease(task, this.owner);
      return dropped ? (clearStop(dropped) ?? dropped) : undefined;
    });
  }

  /** The live lease another process holds on this task, if any. */
  async heldElsewhere(task: TaskWorkspace | undefined): Promise<RunLease | undefined> {
    const held = task?.pipeline?.runLease;
    if (!held || sameOwner(held, this.owner)) return undefined;
    return (await this.alive(held)) ? held : undefined;
  }

  /** Asks whoever holds the task to stop its run. */
  async requestStop(taskId: string, at: string): Promise<boolean> {
    return (await this.repository.update(taskId, (task) => requestStop(task, at))) !== undefined;
  }

  private async alive(lease: RunLease): Promise<boolean> {
    if (lease.host !== this.host) return true;
    try {
      const [probe] = await this.probe([lease.pid]);
      return leaseOwnerAlive(lease, this.host, probe);
    } catch {
      // A probe that failed says nothing, and nothing is not permission to take over.
      return true;
    }
  }
}

/** This process's identity, as a lease records it. */
export function currentProcess(): { pid: number; processStartedAt: string } {
  return {
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

export function describeHolder(holder: RunLease | undefined): string {
  if (!holder) return "Somebody else took this task a moment ago.";
  const who = holder.by === "vscode" ? "VS Code" : "A headless runner";
  return `${who} (pid ${holder.pid}) has been advancing this route since ${holder.acquiredAt}.`;
}
