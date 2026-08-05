import { TaskWorkspace } from "../domain/taskWorkspace";
import { TaskStage } from "../domain/taskPipeline";
import { applyRules } from "../domain/pipelineEngine";
import {
  ImplausibleChangeSet,
  implausibleChangeSet,
} from "../domain/changedPathSanity";
import { needsRuleConfirmation } from "../domain/ruleConfirmation";
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

/** What the user is being asked to approve, with the evidence for it. */
export interface RuleAdditionRequest {
  task: TaskWorkspace;
  added: TaskStage[];
  matches: RuleMatch[];
  /** Named because it is the number that explains a surprising set of reviews. */
  changedPathCount: number;
}

/** Stable across iterations of the driver's loop, distinct across different sets. */
function additionKey(taskId: string, added: readonly TaskStage[]): string {
  return `${taskId}:${added.map((s) => s.id).sort().join(",")}`;
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
    /**
     * Asks whether to append several rule-added reviews. Injected, so this service
     * stays free of UI — and absent headlessly, where there is nobody to ask and the
     * reviews are applied as before.
     */
    private readonly confirm?: (request: RuleAdditionRequest) => Promise<boolean>,
  ) {}

  /**
   * Sets already declined this session, keyed by task and stage ids.
   *
   * In memory rather than persisted, deliberately. A permanently suppressed review is
   * exactly what the harness exists to prevent, and the answer is about a particular
   * diff — so it lapses when the window does, and is asked again.
   */
  private readonly declined = new Set<string>();

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
  ): Promise<
    Result<
      {
        added: TaskStage[];
        plan: ReviewPlan;
        /** Set when the path set was too large to act on; nothing was added. */
        implausible?: ImplausibleChangeSet;
        /** Reviews the user declined this session; nothing was added. */
        declined?: TaskStage[];
      },
      GitError
    >
  > {
    const planned = await this.plan(task, signal);
    if (!planned.ok) return planned;

    const pipeline = task.pipeline;
    if (!pipeline) {
      return ok({ added: [], plan: planned.value });
    }

    const loaded = this.loadRules(task.repositoryRoot);
    const paths = planned.value.changedPaths;

    // The inputs, before the outcome. The engine used to report only that it had
    // added five reviews, which reads as the rules doing their job; the fact that it
    // had been handed 9,569 changed paths — the thing that made every rule match —
    // appeared nowhere. A decision derived from data should say what data.
    this.logger.info(
      `Task "${task.name}": evaluating ${loaded.rules.length} review rule(s) against ` +
        `${paths.length} changed path(s), diffed from "${task.branchName}" against ` +
        `"${task.baseBranch}".`,
    );

    // Checked after logging, so the count that triggered it is on the line above.
    const implausible = implausibleChangeSet(paths, task.baseBranch);
    if (implausible) {
      this.logger.warn(`Task "${task.name}": ${implausible.message}`);
      return ok({ added: [], plan: planned.value, implausible });
    }

    const result = applyRules(pipeline, paths, loaded.rules);
    if (result.added.length === 0) {
      return ok({ added: [], plan: planned.value });
    }

    // Asked before saving, so declining leaves the pipeline exactly as it was rather
    // than adding stages and then removing them.
    if (this.confirm && needsRuleConfirmation(result.added)) {
      const key = additionKey(task.id, result.added);
      // Asked once per distinct set per session. The driver loops, so without this it
      // would ask on every iteration; and the answer is about a specific set of
      // reviews, so a different set is a different question.
      if (!this.declined.has(key)) {
        const accepted = await this.confirm({
          task,
          added: result.added,
          matches: result.matches,
          changedPathCount: paths.length,
        });
        if (!accepted) this.declined.add(key);
      }
      if (this.declined.has(key)) {
        this.logger.warn(
          `Task "${task.name}": declined ${result.added.length} rule-added review(s): ` +
            `${result.added.map((s) => s.name).join(", ")}. They will be offered again ` +
            `next session — a declined review is suppressed for now, never permanently.`,
        );
        return ok({ added: [], plan: planned.value, declined: result.added });
      }
    }

    // Which paths, not just which rules. A review appended for a reason nobody can
    // see is one nobody can judge — and today's five were all matched off paths that
    // belonged to another branch entirely.
    for (const match of result.matches) {
      this.logger.info(
        `Task "${task.name}": rule "${match.rule.id}" matched ` +
          `${match.matchedPaths.length} path(s): ` +
          `${match.matchedPaths.slice(0, 5).join(", ")}` +
          (match.matchedPaths.length > 5
            ? ` (+${match.matchedPaths.length - 5} more)`
            : ""),
      );
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
