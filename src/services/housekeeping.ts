import {
  refreshCheckDeclarations,
  refreshGateDeclarations,
  refreshRulePaths,
  refreshStageLabels,
  StageDefinitionSource,
} from "../domain/stageRefresh";
import { claimAnswers, orphanedAnswers } from "../domain/hostRequests";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Logger } from "../logging/logger";
import { TaskRepository } from "../persistence/taskRepository";
import { externalWaitSince, groupForTask } from "../ui/taskGrouping";

/**
 * The repairs a harness needs done in the background, whichever client is open.
 *
 * Each of these used to live in `extension.ts`, behind a VS Code timer or watcher — so a
 * repository driven only from Claude never had its abandoned subtasks reclaimed, never
 * heard about a tester's reply, and never picked up a `harness.json` edit on a gate
 * already waiting. Here they are one vscode-free module, called by the extension on its
 * own timers and by `harnessRunner tick`, which the Claude pane runs while it is open.
 * Two hosts running them at once is safe: every job is idempotent, writes go through
 * `repository.update`/`save` on the shared state file, and a task another live process
 * holds the run lease on is left to that process.
 *
 * Every job swallows its own failure, the rule each of them followed in the extension:
 * a repair that fails must not take its host down with it.
 */
export interface HousekeepingDeps {
  repository: TaskRepository;
  runner: {
    reclaimStale(task: TaskWorkspace, at: string): Promise<{ reclaimed: readonly unknown[] }>;
  };
  leases: {
    heldElsewhere(task: TaskWorkspace | undefined): Promise<unknown>;
    releaseDead(task: TaskWorkspace): Promise<boolean>;
  };
  feedback: { poll(repositoryRoot: string): Promise<{ arrived: TaskWorkspace[] }> };
  agentProcesses: {
    sweep(activeSubtaskIds: ReadonlySet<string>, runningTaskIds?: ReadonlySet<string>): Promise<void>;
  };
  /** The project's routes as config says now, or undefined when none can be read. */
  definitions: () => StageDefinitionSource | undefined;
  /** `feedbackPollMinutes`; zero switches the poll off. */
  feedbackPollMinutes: () => number;
  logger: Logger;
  now: () => string;
}

export interface HousekeepingReport {
  /** Tasks whose run lease named a process that has died, now free to advance. */
  leasesReleased: string[];
  /** Subtasks left `active` by a host that is gone, now pending again. */
  reclaimed: number;
  /** Tasks whose answers, given after the asking session died, went into the brief. */
  answersDelivered: string[];
  /** Tasks a ticket reply moved back to the operator. */
  feedbackArrived: string[];
  /** `<task>: <stage ids>` for each task whose stages were brought into line with config. */
  configSynced: string[];
}

export class Housekeeping {
  constructor(private readonly deps: HousekeepingDeps) {}

  /** Every job once, in the order that lets each see the last one's writes. */
  async tick(repositoryRoot: string): Promise<HousekeepingReport> {
    const leasesReleased = (await this.releaseDeadLeases(repositoryRoot)).map((task) => task.name);
    const reclaimed = await this.reclaimStale(repositoryRoot);
    // After the reclaim, which is what turns a dead session's question into a brief one.
    const answersDelivered = (await this.deliverOrphanedAnswers(repositoryRoot)).map(
      (task) => task.name,
    );
    const configSynced = await this.syncRouteConfig(repositoryRoot);
    const feedbackArrived = (await this.pollFeedback(repositoryRoot)).map(
      (task) => task.origin?.ref ?? task.name,
    );
    await this.sweepAgentProcesses(repositoryRoot);
    return { leasesReleased, reclaimed, answersDelivered, feedbackArrived, configSynced };
  }

  /**
   * Frees tasks whose run lease names a process that has died.
   *
   * A runner that crashes, or a VS Code window that closes mid-advance, leaves its lease
   * behind, and both clients read a lease as a run in progress: the task showed
   * "Advancing" with a Stop button and no Advance for days. Nothing is advanced here.
   */
  async releaseDeadLeases(repositoryRoot: string): Promise<TaskWorkspace[]> {
    try {
      const released: TaskWorkspace[] = [];
      for (const task of await this.deps.repository.getByRepository(repositoryRoot)) {
        if (!task.pipeline?.runLease) continue;
        if (!(await this.deps.leases.releaseDead(task))) continue;
        this.deps.logger.info(
          `Harness [${task.name}] the process advancing it (pid ${task.pipeline.runLease.pid}) is gone, so the route is free to advance again.`,
        );
        released.push(task);
      }
      return released;
    } catch (error) {
      this.deps.logger.warn(`Could not release leases held by stopped processes: ${String(error)}`);
      return [];
    }
  }

  /**
   * Reclaims subtasks a dead host left `active`.
   *
   * Every mechanism that ends a subtask lives in the owning host's memory, so a host
   * that goes takes them all with it and the record stays `active` with no reply. A
   * task another live process holds the lease on is skipped: its subtasks are being
   * run, and reclaiming them would re-open work still being done.
   */
  async reclaimStale(repositoryRoot: string): Promise<number> {
    try {
      let reclaimed = 0;
      for (const task of await this.deps.repository.getByRepository(repositoryRoot)) {
        if (!task.pipeline) continue;
        if (await this.deps.leases.heldElsewhere(task)) continue;
        reclaimed += (await this.deps.runner.reclaimStale(task, this.deps.now())).reclaimed.length;
      }
      return reclaimed;
    } catch (error) {
      this.deps.logger.warn(`Could not sweep for abandoned stage subtasks: ${String(error)}`);
      return 0;
    }
  }

  /**
   * Moves answers nothing live can receive into the brief.
   *
   * Only a process running a stage delivers answers, so with only Claude open an answer
   * given after the asking session died was marked submitted and never read: the task
   * sat parked holding it. Claimed inside the write, so a window serving the same file
   * cannot deliver it twice, and a task another live process holds is left to it.
   * Nothing is advanced — starting work is the operator's, and Advance now runs the
   * stage with the answer in its brief.
   */
  async deliverOrphanedAnswers(repositoryRoot: string): Promise<TaskWorkspace[]> {
    try {
      const delivered: TaskWorkspace[] = [];
      for (const task of await this.deps.repository.getByRepository(repositoryRoot)) {
        if (!orphanedAnswers(task)) continue;
        if (await this.deps.leases.heldElsewhere(task)) continue;
        const at = this.deps.now();
        const saved = await this.deps.repository.update(task.id, (current) =>
          current && orphanedAnswers(current) ? claimAnswers(current, at)?.task : undefined,
        );
        if (!saved) continue;
        this.deps.logger.info(
          `Harness [${saved.name}] the stage that asked is gone, so its answers went into the brief. Advance Route runs it with them.`,
        );
        delivered.push(saved);
      }
      return delivered;
    } catch (error) {
      this.deps.logger.warn(`Could not deliver answers left for a stopped stage: ${String(error)}`);
      return [];
    }
  }

  /** Checks the tickets of tasks waiting on others; returns the tasks a reply moved. */
  async pollFeedback(repositoryRoot: string): Promise<TaskWorkspace[]> {
    if (this.deps.feedbackPollMinutes() <= 0) return [];
    try {
      return (await this.deps.feedback.poll(repositoryRoot)).arrived;
    } catch (error) {
      this.deps.logger.warn(`Could not poll tickets for replies: ${String(error)}`);
      return [];
    }
  }

  /**
   * Brings every task's stages into line with the project's routes.
   *
   * Its own pass rather than part of the advance path, because the tasks that need it
   * most are the ones nobody is advancing: a verification gate is `awaiting-approval`
   * for its whole useful life. Four passes, one save — each takes the previous one's
   * pipeline, and the save must use the LAST of them, or a pass computes its
   * corrections and throws them away. Saves only when something differs.
   */
  async syncRouteConfig(repositoryRoot: string): Promise<string[]> {
    const source = this.deps.definitions();
    if (!source) return [];
    try {
      const corrected: string[] = [];
      for (const task of await this.deps.repository.getByRepository(repositoryRoot)) {
        if (!task.pipeline) continue;
        const gates = refreshGateDeclarations(task.pipeline, source);
        const checks = refreshCheckDeclarations(gates.pipeline, source);
        const paths = refreshRulePaths(checks.pipeline, source);
        const labels = refreshStageLabels(paths.pipeline, source);
        const changed = [
          ...new Set([...gates.changed, ...checks.changed, ...paths.changed, ...labels.changed]),
        ];
        if (changed.length === 0) continue;
        await this.deps.repository.save({ ...task, pipeline: labels.pipeline, updatedAt: this.deps.now() });
        corrected.push(`${task.name}: ${changed.join(", ")}`);
      }
      if (corrected.length > 0) {
        this.deps.logger.info(
          `Harness reloaded route config from harness.json for ${corrected.length} ` +
            `task(s): ${corrected.join(" | ")}`,
        );
      }
      return corrected;
    } catch (error) {
      this.deps.logger.warn(`Could not sync route config: ${String(error)}`);
      return [];
    }
  }

  /**
   * Reaps agent processes an unclean shutdown left running.
   *
   * Keyed on every subtask any pipeline considers running, plus every task another live
   * process holds the lease on. The second set is what makes this safe from a second
   * host: a run that starts a subtask between this snapshot and the registry read has a
   * record and no `active` subtask in the snapshot, and only its lease says it is live.
   */
  async sweepAgentProcesses(repositoryRoot: string): Promise<void> {
    try {
      const active = new Set<string>();
      const running = new Set<string>();
      for (const task of await this.deps.repository.getByRepository(repositoryRoot)) {
        if (task.pipeline && (await this.deps.leases.heldElsewhere(task))) running.add(task.id);
        for (const stage of task.pipeline?.stages ?? []) {
          for (const subtask of stage.subtasks) {
            if (subtask.status === "active") active.add(subtask.id);
          }
        }
      }
      await this.deps.agentProcesses.sweep(active, running);
    } catch (error) {
      this.deps.logger.warn(`Harness could not sweep agent processes: ${String(error)}`);
    }
  }
}

/**
 * When a task's wait on others began, or undefined when it is not waiting on others.
 *
 * The tree's own rule, asked without the feedback so a task already pulled back by a
 * reply still counts as one whose wait is in play.
 */
export function feedbackWaitingSince(task: TaskWorkspace): string | undefined {
  return groupForTask({ status: task.status, pipeline: task.pipeline, heldCalls: 0 }) ===
    "waiting-others"
    ? externalWaitSince(task.pipeline)
    : undefined;
}
