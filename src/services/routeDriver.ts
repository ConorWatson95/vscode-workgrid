import { prepareAdvance } from "../domain/advancePreparation";
import { stopRequested } from "../domain/runLease";
import { StageDefinitionSource } from "../domain/stageRefresh";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Logger } from "../logging/logger";
import { TaskRepository } from "../persistence/taskRepository";
import { PipelineRunner, RunReport } from "./pipelineRunner";
import { RunLeaseService } from "./runLeaseService";

export interface RouteDriverDeps {
  repository: TaskRepository;
  runner: PipelineRunner;
  leases: RunLeaseService;
  /** The project's routes as they are on disk now, or undefined if unreadable. */
  definitions: () => StageDefinitionSource | undefined;
  logger: Logger;
  now: () => string;
  /**
   * Calls back whenever the state file changes, and returns how to stop listening.
   * How a stop asked for by another client reaches this run; absent, only this
   * process can stop it.
   */
  watchState?: (onChange: () => void) => () => void;
  /** Where this run's log goes, recorded on the lease for whoever wants to read it. */
  logPath?: string;
}

export type DriveResult =
  | { kind: "refused"; message: string }
  | { kind: "ran"; task: TaskWorkspace; report: RunReport; warnings: string[] };

/**
 * One advance of a route, as every runner performs it: take the run lease, bring the
 * pipeline in line with config, drive it, give the lease back.
 *
 * Shared by the extension's Advance Route and the headless runner so the two cannot
 * drift — the lease is the only thing standing between them and two runners on one
 * task, and a runner that skipped `prepareAdvance` would run a route the operator had
 * already corrected. Everything a person sees about the outcome stays with the caller.
 */
export async function driveRoute(deps: RouteDriverDeps, taskId: string): Promise<DriveResult> {
  const { repository, runner, leases, logger } = deps;
  const task = await repository.get(taskId);
  if (!task) return { kind: "refused", message: "That task no longer exists." };
  if (!task.pipeline) {
    return { kind: "refused", message: `"${task.name}" has no route, so there is nothing to advance.` };
  }
  if (runner.isRunning(task.id)) {
    return { kind: "refused", message: `"${task.name}" is already advancing. Stop it to interrupt it.` };
  }

  const leased = await leases.acquire(task.id, deps.now(), deps.logPath);
  if (!leased.ok) return { kind: "refused", message: `"${task.name}": ${leased.message}` };

  let unwatch: (() => void) | undefined;
  try {
    let advancing = leased.task;
    const prepared = prepareAdvance(advancing.pipeline!, deps.definitions(), deps.now());
    for (const note of prepared.notes) logger.info(`Harness [${task.name}] ${note}`);
    for (const warning of prepared.warnings) logger.warn(`Harness [${task.name}] ${warning}`);
    if (prepared.changed) {
      advancing = { ...advancing, pipeline: prepared.pipeline, updatedAt: deps.now() };
      await repository.save(advancing);
    }

    // Read on change rather than polled: the file is rewritten whole and can be many
    // megabytes, and a stop is rare.
    unwatch = deps.watchState?.(() => {
      void repository.get(task.id).then((latest) => {
        if (stopRequested(latest, leases.identity)) {
          logger.info(`Harness [${task.name}] stop requested from another client.`);
          runner.cancel(task.id);
        }
      });
    });

    const report = await runner.advance(advancing);
    for (const step of report.steps) logger.info(`Harness [${task.name}] ${step}`);
    return { kind: "ran", task: advancing, report, warnings: prepared.warnings };
  } finally {
    unwatch?.();
    try {
      await leases.release(task.id);
    } catch (error) {
      // The owner is this process, so a lease left behind is taken over once it exits.
      logger.error(`Harness [${task.name}] could not release its run lease.`, error);
    }
  }
}
