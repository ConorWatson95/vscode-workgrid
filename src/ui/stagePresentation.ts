import { ChecklistItem, TaskPipeline, TaskStage } from "../domain/taskPipeline";

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

export function stagePresentation(stage: TaskStage): StageVisual {
  const detail = stageDetail(stage);

  switch (stage.status) {
    case "active":
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
        description: "",
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
function stageDetail(stage: TaskStage): string {
  const parts: string[] = [];

  if (stage.subtasks.length > 1) {
    const done = stage.subtasks.filter(
      (s) => s.status !== "pending" && s.status !== "active",
    ).length;
    parts.push(`${done}/${stage.subtasks.length}`);
  }

  const outstanding = (stage.checklist ?? []).filter((i) => !i.checked).length;
  if (outstanding > 0) {
    parts.push(`${outstanding} to verify`);
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
