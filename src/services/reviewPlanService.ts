import { TaskWorkspace } from "../domain/taskWorkspace";
import { TaskStage } from "../domain/taskPipeline";
import { applyRules } from "../domain/pipelineEngine";
import { RuleMatch, ruleStageDefinition } from "../domain/reviewRules";
import { LoadedReviewRules, loadReviewRules } from "./reviewRulesService";
import { TaskRepository } from "../persistence/taskRepository";
import { GitError } from "../git/gitClient";
import { Result, ok } from "../utilities/result";
import { Logger } from "../logging/logger";

/**
 * Joins the three pieces of the harness that already exist — git's changed
 * paths, the project's review rules, and the pipeline engine — into one
 * answerable question: *given what this task has actually touched, which
 * reviews does it owe?*
 *
 * Deliberately works for unharnessed tasks too. A task with no pipeline still
 * gets a truthful advisory answer, which is what makes this useful before the
 * route/orchestration UI exists.
 */

/** Narrow view of GitStatusService, so tests need no git. */
export interface ChangedPathsSource {
  getChangedPaths(
    worktreePath: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<Result<string[], GitError>>;
}

/** Injected so tests can supply rules without touching the filesystem. */
export type ReviewRulesLoader = (repositoryRoot: string) => LoadedReviewRules;

export interface RequiredReview {
  /** Rule that demanded it. */
  ruleId: string;
  /** Why, in the rule author's words. */
  reason: string;
  stageId: string;
  stageLabel: string;
  /** Paths that triggered it, so the requirement can be justified. */
  triggeredBy: string[];
  /** True when this review is already a stage on the task's pipeline. */
  alreadyOnPipeline: boolean;
}

export interface ReviewPlan {
  changedPaths: string[];
  required: RequiredReview[];
  /** Rules file used, when a project supplied one. */
  rulesSource?: string;
  /** True when this project defines no usable rules, so nothing is required. */
  noRulesConfigured: boolean;
  /** Validation problems from the project's rules file. */
  problems: string[];
  /** False when the task has no pipeline, so nothing can be appended yet. */
  harnessed: boolean;
}

export class ReviewPlanService {
  constructor(
    private readonly changedPaths: ChangedPathsSource,
    private readonly repository: TaskRepository,
    private readonly logger: Logger,
    private readonly loadRules: ReviewRulesLoader = (root) =>
      loadReviewRules(root),
  ) {}

  /**
   * Computes the reviews a task owes. Reports rather than mutates, so it is safe
   * to call for display.
   */
  async plan(
    task: TaskWorkspace,
    signal?: AbortSignal,
  ): Promise<Result<ReviewPlan, GitError>> {
    const paths = await this.changedPaths.getChangedPaths(
      task.worktreePath,
      task.baseBranch,
      signal,
    );
    if (!paths.ok) return paths;

    // Rules come from the repository root, never the worktree, so a task branch
    // cannot relax the reviews it is subject to.
    const loaded = this.loadRules(task.repositoryRoot);
    for (const problem of loaded.problems) {
      this.logger.warn(`Review rules: ${problem}`);
    }

    // evaluateRules runs inside applyRules; reuse it against an empty pipeline
    // so matching logic has exactly one implementation.
    const existingStageIds = new Set(
      (task.pipeline?.stages ?? []).map((s) => s.id),
    );
    const { matches } = applyRules(
      { routeId: task.pipeline?.routeId ?? "unharnessed", stages: [] },
      paths.value,
      loaded.rules,
    );

    return ok({
      changedPaths: paths.value,
      required: matches.map((match) => describeMatch(match, existingStageIds)),
      rulesSource: loaded.sourcePath,
      noRulesConfigured: loaded.noRulesConfigured,
      problems: loaded.problems,
      harnessed: task.pipeline !== undefined,
    });
  }

  /**
   * Appends any missing review stages to a harnessed task's pipeline and
   * persists it. A task with no pipeline is left alone — inventing a route for
   * it would fabricate stage history that never happened.
   */
  async apply(
    task: TaskWorkspace,
    signal?: AbortSignal,
  ): Promise<Result<{ added: TaskStage[]; plan: ReviewPlan }, GitError>> {
    const planned = await this.plan(task, signal);
    if (!planned.ok) return planned;

    const pipeline = task.pipeline;
    if (!pipeline) {
      return ok({ added: [], plan: planned.value });
    }

    const loaded = this.loadRules(task.repositoryRoot);
    const result = applyRules(pipeline, planned.value.changedPaths, loaded.rules);
    if (result.added.length === 0) {
      return ok({ added: [], plan: planned.value });
    }

    await this.repository.save({
      ...task,
      pipeline: result.pipeline,
      updatedAt: new Date().toISOString(),
    });
    this.logger.info(
      `Task "${task.name}": added ${result.added.length} required review(s): ` +
        result.added.map((s) => s.name).join(", "),
    );
    // Loud, because it is the difference between a review that can prevent something
    // and one that can only report on it. A rule review spliced in behind a UAT
    // promotion also runs after a stage that may have moved the worktree, which is
    // how a migration review came to report truthfully about the wrong branch.
    if (result.deployedAlready.length > 0) {
      this.logger.warn(
        `Task "${task.name}": ${result.added.map((s) => s.name).join(", ")} could only be ` +
          `placed AFTER ${result.deployedAlready.map((s) => s.name).join(", ")}, which ` +
          `already ran. These reviews cannot prevent what those stages did — treat their ` +
          `findings as something to undo, not to avoid. If this rule should always run ` +
          `before a deployment, the route needs it as a declared stage rather than a rule.`,
      );
    }

    return ok({ added: result.added, plan: planned.value });
  }
}

function describeMatch(
  match: RuleMatch,
  existingStageIds: ReadonlySet<string>,
): RequiredReview {
  const stage = ruleStageDefinition(match.rule);
  return {
    ruleId: match.rule.id,
    reason: match.rule.reason,
    stageId: stage.id,
    stageLabel: stage.label,
    triggeredBy: match.matchedPaths,
    alreadyOnPipeline: existingStageIds.has(stage.id),
  };
}

/** Renders a plan for the output channel. */
export function formatReviewPlan(task: TaskWorkspace, plan: ReviewPlan): string {
  const lines: string[] = [
    `Required reviews for "${task.name}" (${plan.changedPaths.length} changed path(s))`,
    plan.rulesSource
      ? `Rules: ${plan.rulesSource}`
      : "Rules: none defined for this project.",
  ];

  if (plan.required.length === 0) {
    lines.push(
      plan.noRulesConfigured
        ? "This project defines no review rules, so no extra reviews are required. " +
            "Run \"Task Workspaces: Create Review Rules File\" to add some."
        : "No rules matched; the route's own stages are sufficient.",
    );
    return lines.join("\n");
  }

  for (const review of plan.required) {
    const state = plan.harnessed
      ? review.alreadyOnPipeline
        ? " [already on pipeline]"
        : " [missing]"
      : "";
    lines.push(`  • ${review.stageLabel}${state} — ${review.reason}`);
    for (const path of review.triggeredBy.slice(0, 5)) {
      lines.push(`      ${path}`);
    }
    if (review.triggeredBy.length > 5) {
      lines.push(`      … and ${review.triggeredBy.length - 5} more`);
    }
  }

  if (!plan.harnessed) {
    lines.push(
      "This task has no route, so these are advisory only. Start a route to enforce them.",
    );
  }
  return lines.join("\n");
}
