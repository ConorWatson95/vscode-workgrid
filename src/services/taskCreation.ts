import { Logger } from "../logging/logger";
import { createPipeline } from "../domain/pipelineEngine";
import { RouteDefinition, assessmentStageDefinition } from "../domain/taskRoute";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { CopyEntry } from "../domain/worktreeCopyPlan";
import { SiblingLinkEntry } from "../domain/siblingLinkPlan";
import { TaskRepository } from "../persistence/taskRepository";
import { Result, ok } from "../utilities/result";
import { CreateTaskInput, ServiceError, TaskWorkspaceService } from "./taskWorkspaceService";
import { WorktreeProvisioner } from "./worktreeProvisioner";

/**
 * Creating a task once its answers are known: the worktree, the untracked config copied
 * into it, the sibling links beside it, and the route.
 *
 * Out of the VS Code command so Claude can start a task too. The command still asks
 * its questions; this is everything after the confirmation, so the two clients cannot
 * create a task two different ways.
 */

export interface TaskCreationDeps {
  service: Pick<TaskWorkspaceService, "createTask">;
  provisioner: Pick<WorktreeProvisioner, "provision" | "linkSiblings">;
  repository: Pick<TaskRepository, "save">;
  logger: Logger;
  now(): string;
}

export interface TaskCreationInput extends CreateTaskInput {
  /** Absent makes a chat task: a worktree and nothing else. */
  route?: RouteDefinition;
  /** Prepends the assessment stage, for work that partly exists already. */
  assessFirst?: boolean;
  copyIntoWorktree: readonly CopyEntry[];
  linkSiblings: readonly SiblingLinkEntry[];
}

export interface TaskCreationOutcome {
  task: TaskWorkspace;
  /** Files that could not be copied into the worktree. The task is usable regardless. */
  provisionProblems: number;
  /** The worktree is real; only the route failed to stick. */
  routeFailed: boolean;
}

export async function createTaskWithRoute(
  deps: TaskCreationDeps,
  input: TaskCreationInput,
  step: (label: string) => void = () => undefined,
): Promise<Result<TaskCreationOutcome, ServiceError>> {
  const { route, assessFirst, copyIntoWorktree, linkSiblings, ...create } = input;

  step("checking out the worktree");
  const created = await deps.service.createTask(create);
  if (!created.ok) return created;
  const task = created.value;

  // Bring across untracked local config before anything runs in the worktree, so the
  // first agent session sees the same settings as the main checkout.
  step("copying local config into the worktree");
  const provisioned = deps.provisioner.provision(copyIntoWorktree, input.repositoryRoot, task.worktreePath);

  // Sibling links go beside the worktree, not in it, and are shared by every task in
  // this parent directory — so this is idempotent and usually does nothing. Run per
  // task anyway: the first task in a fresh worktree directory is the one that needs
  // them, and there is no other moment that reliably happens.
  step("linking sibling repositories");
  deps.provisioner.linkSiblings(linkSiblings, input.repositoryRoot, task.worktreePath);

  // Attach the pipeline after the worktree exists, so a failed creation never leaves a
  // harnessed task with no worktree behind it.
  let routeFailed = false;
  if (route) {
    step(`attaching the ${route.label} route`);
    const harnessed: TaskWorkspace = {
      ...task,
      pipeline: createPipeline(
        assessFirst ? { ...route, stages: [assessmentStageDefinition(), ...route.stages] } : route,
      ),
      updatedAt: deps.now(),
    };
    try {
      await deps.repository.save(harnessed);
      task.pipeline = harnessed.pipeline;
      task.updatedAt = harnessed.updatedAt;
    } catch (error) {
      deps.logger.error(`Created "${task.name}" but could not attach the ${route.id} route`, error);
      routeFailed = true;
    }
  }

  return ok({ task, provisionProblems: provisioned.problems.length, routeFailed });
}

/** One sentence for a creation that failed, worded for the person who asked. */
export function describeCreateError(error: ServiceError): string {
  if (error.kind === "validation" || error.kind === "notFound") return error.message;
  const inner = error.error;
  if (inner.kind === "validation" || inner.kind === "dirty" || inner.kind === "unmerged") {
    return inner.message;
  }
  return `Git error: ${inner.error.message}`;
}
