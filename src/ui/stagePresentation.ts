import { ChecklistItem, TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { findingsOfSubtasks, summariseFindings } from "../domain/reviewFindings";
import { isCorrectable, undoableCorrection } from "../domain/pipelineEngine";

/**
 * Presentation for pipeline stages in the tree. Pure, so the labelling rules are
 * unit-tested rather than only visible by running the extension.
 */

export interface StageVisual {
  iconId: string;
  colorId?: string;
  /** Human-readable status, used in tooltips. */
  label: string;
  /** Short suffix shown after the stage name, or "" when there is nothing to add. */
  description: string;
  /** Distinguishes stage states for context-menu `when` clauses. */
  contextValue: string;
}

export function stagePresentation(
  stage: TaskStage,
  /**
   * Unchecked verification items across the **whole pipeline**.
   *
   * Passed in because a human-verification stage is blocked by every outstanding
   * item, not only the ones it raised itself — and it raises none. Reading
   * `stage.checklist` alone left the gate showing no count while refusing to pass.
   */
  outstandingInPipeline?: number,
): StageVisual {
  const visual = statusVisual(stage, outstandingInPipeline);
  // A second token rather than a status of its own: "has output to correct" is
  // orthogonal to what the stage is doing, and a correction leaves the stage
  // `pending` while still holding everything it produced.
  const tokens = [visual.contextValue];
  if (isCorrectable(stage)) tokens.push("correctable");
  // Separate token, and not implied by `correctable`: withdrawing a correction is
  // only offered on a stage that actually has one, and a stage can be correctable
  // without ever having been corrected.
  if (undoableCorrection(stage)) tokens.push("has-correction");
  return tokens.length === 1 ? visual : { ...visual, contextValue: tokens.join(" ") };
}

function statusVisual(stage: TaskStage, outstandingInPipeline?: number): StageVisual {
  const detail = stageDetail(stage, outstandingInPipeline);

  // A stage the engine has not settled but which is holding a failed subtask is not
  // running, whatever its status says. `finishSubtask` fails a *stage* only once every
  // subtask has resolved — right for judging the stage — and the driver stops at the
  // first failure rather than spending sessions on siblings whose plan is probably
  // wrong. So the common shape of a failed stage is `active` with one failed subtask
  // and the rest pending: the row spun, in blue, on a route that had stopped, and the
  // reason for the stop was not on it anywhere.
  //
  // Two things follow from reading it correctly, and the second is the one that
  // matters: the row carries the failure reason, and its `contextValue` becomes
  // `stage-failed`, which is what **Retry This Stage** is keyed on. Keyed on a failed
  // subtask rather than on "nothing is active", because a subtask reverted by a
  // question or a held call leaves the same shape while the route is legitimately
  // waiting — `stageBlock` already presents those — and because a failure is terminal,
  // so there is no window mid-advance where this misreads a stage between subtasks.
  const failedSubtask = stage.subtasks.some((s) => s.status === "failed");

  switch (stage.status) {
    case "active":
      if (failedSubtask) {
        return {
          iconId: "error",
          colorId: "charts.red",
          label: "Failed",
          description: firstFailureReason(stage) ?? "failed",
          contextValue: "stage-failed",
        };
      }
      return {
        iconId: "loading~spin",
        colorId: "charts.blue",
        label: "In progress",
        description: detail,
        contextValue: "stage-active",
      };
    case "awaiting-approval":
      return {
        iconId: "comment-unresolved",
        colorId: "charts.yellow",
        label: "Awaiting approval",
        description: detail ? `awaiting approval · ${detail}` : "awaiting approval",
        contextValue: "stage-awaiting-approval",
      };
    case "passed":
      return {
        iconId: "pass-filled",
        colorId: "charts.green",
        label: "Passed",
        // A behaviour-review stage passes as soon as it has *written* the
        // checklist — planning was its whole job. So the stage holding the items
        // is green and, with an empty description, said nothing about them at all,
        // while the gate they block belongs to a different stage. The items were
        // invisible from both ends.
        description: detail,
        contextValue: "stage-passed",
      };
    case "failed":
      return {
        iconId: "error",
        colorId: "charts.red",
        label: "Failed",
        description: firstFailureReason(stage) ?? "failed",
        contextValue: "stage-failed",
      };
    case "skipped":
      return {
        iconId: "debug-step-over",
        label: "Skipped",
        description: "skipped",
        contextValue: "stage-skipped",
      };
    case "pending":
      return {
        iconId: stage.splittable && stage.subtasks.length === 0 ? "list-tree" : "circle-outline",
        label: "Pending",
        description:
          stage.splittable && stage.subtasks.length === 0 ? "needs planning" : detail,
        contextValue: "stage-pending",
      };
  }
}

/**
 * Progress detail for a stage: subtask counts and outstanding verification.
 * Omits a count for a single-unit stage, where "0/1" is noise.
 */
function stageDetail(stage: TaskStage, outstandingInPipeline?: number): string {
  const parts: string[] = [];

  if (stage.subtasks.length > 1) {
    const done = stage.subtasks.filter(
      (s) => s.status !== "pending" && s.status !== "active",
    ).length;
    parts.push(`${done}/${stage.subtasks.length}`);
  }

  // A human-verification stage raises no items of its own but is blocked by all of
  // them, so it reports the pipeline total; every other stage reports its own.
  const outstanding =
    stage.kind === "humanVerification" && outstandingInPipeline !== undefined
      ? outstandingInPipeline
      : (stage.checklist ?? []).filter((i) => !i.checked).length;
  // A review's findings, on the row. A stage that reported a critical problem and
  // then passed — because reviewing was its job and it did it — was a green row
  // saying nothing, so the findings were only discoverable by opening the report.
  // Read only from the subtasks that reached a conclusion: a failed one's reply is
  // the CLI's account of the failure, and "API Error: 529 Overloaded" parses as a
  // critical. See `findingsOfSubtasks`.
  const findings = summariseFindings(findingsOfSubtasks(stage.subtasks));
  if (findings) parts.push(findings);

  if (outstanding > 0) {
    // "for you" because a passed stage carrying unchecked items looks stalled
    // otherwise — as though the agent had left something undone. It has not: a
    // behaviour-review stage is a planner, and the items are the reader's job.
    parts.push(`${outstanding} for you to verify`);
  }
  return parts.join(" · ");
}

function firstFailureReason(stage: TaskStage): string | undefined {
  return stage.subtasks.find((s) => s.failureReason)?.failureReason;
}

/** Icon and label for one verification item. */
export function checklistPresentation(item: ChecklistItem): {
  iconId: string;
  colorId?: string;
  contextValue: string;
} {
  return item.checked
    ? { iconId: "check", colorId: "charts.green", contextValue: "checklist-checked" }
    : { iconId: "circle-large-outline", contextValue: "checklist-unchecked" };
}

/**
 * One-line pipeline summary for a task row, e.g. "Bug fix · 2/5 · 3 to verify".
 * Returns undefined for an unharnessed task so the caller shows nothing rather
 * than an empty separator.
 */
export function pipelineSummary(
  pipeline: TaskPipeline | undefined,
  routeLabel?: string,
): string | undefined {
  if (!pipeline || pipeline.stages.length === 0) return undefined;

  const done = pipeline.stages.filter(
    (s) => s.status === "passed" || s.status === "skipped",
  ).length;
  const outstanding = pipeline.stages
    .filter((s) => s.status !== "skipped")
    .flatMap((s) => s.checklist ?? [])
    .filter((i) => !i.checked).length;

  const parts = [routeLabel ?? pipeline.routeId, `${done}/${pipeline.stages.length}`];
  if (outstanding > 0) parts.push(`${outstanding} to verify`);
  return parts.join(" · ");
}

/** Whether a stage row can be opened, and whether it should start open. */
export interface StageExpansion {
  /** Number of rows nested under the stage. Zero means it must be a leaf. */
  childCount: number;
  /** True when something underneath is waiting on the user. */
  needsAttention: boolean;
}

/**
 * Decides a stage row's expansion from what is nested under it.
 *
 * Extracted because getting it wrong has produced the same bug twice: a stage
 * whose only children were refusals (0.19.3), and then one whose only children
 * were questions, counted zero children, became a leaf, and left the rows that
 * resolve them unreachable. Anything that nests under a stage **must** be counted
 * here, and the rule is only testable away from `vscode`.
 */
export function stageExpansion(
  pipeline: TaskPipeline | undefined,
  stage: TaskStage,
): StageExpansion {
  const checklist = stage.checklist ?? [];
  const denials =
    pipeline?.pendingDenials?.stageId === stage.id
      ? (pipeline.pendingDenials.items ?? [])
      : [];
  const questions =
    pipeline?.pendingQuestion?.stageId === stage.id
      ? (pipeline.pendingQuestion.items ?? [])
      : [];

  return {
    childCount: checklist.length + denials.length + questions.length,
    needsAttention:
      checklist.some((item) => !item.checked) ||
      denials.some((denial) => !denial.granted) ||
      questions.some((question) => (question.answer ?? "").trim().length === 0),
  };
}

/** What a stage cannot proceed without, when it is waiting on a person. */
export interface StageBlock {
  kind: "questions" | "refusals";
  count: number;
}

/**
 * Whether a stage is actually waiting on the user rather than working.
 *
 * The distinction the tree could not previously draw: an `active` stage sitting
 * on seven unanswered questions rendered with the same spinner as one busily
 * running, so "is it stuck or has it moved on?" had no answer on screen.
 *
 * Questions outrank refusals: a stage that asked something has stopped dead,
 * whereas a refusal may only have cost it one tool.
 */
export function stageBlock(
  pipeline: TaskPipeline | undefined,
  stage: TaskStage,
): StageBlock | undefined {
  const questions =
    pipeline?.pendingQuestion?.stageId === stage.id
      ? (pipeline.pendingQuestion.items ?? []).filter(
          (item) => (item.answer ?? "").trim().length === 0,
        ).length
      : 0;
  if (questions > 0) return { kind: "questions", count: questions };

  const refusals =
    pipeline?.pendingDenials?.stageId === stage.id
      ? (pipeline.pendingDenials.items ?? []).filter((item) => !item.granted).length
      : 0;
  if (refusals > 0) return { kind: "refusals", count: refusals };

  return undefined;
}

/**
 * How a blocked stage should look, replacing its in-progress appearance.
 *
 * `contextValue` is deliberately left to the caller: it drives menu `when`
 * clauses, and changing it to signal a block would silently remove the actions
 * that resolve the block.
 */
export function blockedStageVisual(block: StageBlock): Omit<StageVisual, "contextValue"> {
  const noun =
    block.count === 1
      ? block.kind === "questions"
        ? "question"
        : "refusal"
      : block.kind;
  return {
    iconId: block.kind === "questions" ? "comment-unresolved" : "shield",
    colorId: "charts.yellow",
    label: "Waiting for you",
    description: `waiting — ${block.count} ${noun}`,
  };
}

/**
 * What the *task* row should say for a harnessed task: the stage actually in
 * play, and whether it is working or waiting.
 *
 * Returns undefined when no stage is in play, so the caller keeps its existing
 * git-derived phase. That phase is route-blind — it reported "implementing" for a
 * task whose planning stage had not finished, because it reads dirty files and
 * commits rather than the pipeline.
 */
export function activeStageLabel(pipeline: TaskPipeline | undefined): string | undefined {
  const stages = pipeline?.stages ?? [];
  const current =
    stages.find((stage) => stage.status === "active") ??
    stages.find((stage) => stage.status === "awaiting-approval");
  if (!current) return undefined;

  const block = stageBlock(pipeline, current);
  if (block) return `${current.name} — ${blockedStageVisual(block).description}`;
  if (current.status === "awaiting-approval") return `${current.name} — awaiting approval`;
  return `${current.name}…`;
}
