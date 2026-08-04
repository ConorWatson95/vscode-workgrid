import { ReviewRule } from "./reviewRules";
import { RouteDefinition } from "./taskRoute";
import { TaskStage } from "./taskPipeline";

/**
 * Resolves which model a stage should run on, preferring current project config
 * over the copy taken when the task was created.
 *
 * A pipeline is a **snapshot**: picking a route fixes the stages the work will
 * travel through, so editing a route cannot rewrite a task already moving through
 * it. That is deliberate and must stay — but it also froze `model`, which is not
 * pipeline state at all. It is an execution knob, so a stage edited to run on a
 * cheaper model went on using the old one until the task was recreated, with
 * nothing in the UI to say why.
 *
 * So: stage *structure* stays snapshotted, stage *model* is resolved fresh.
 * Matching is by id, which is what makes this safe — a stage whose id is no
 * longer in the config keeps whatever it was created with rather than losing its
 * override.
 *
 * Pure and vscode-free.
 */

export interface StageModelSource {
  routes: readonly RouteDefinition[];
  rules: readonly ReviewRule[];
}

/**
 * The model for one stage, or undefined to leave the extension-wide default in
 * place.
 *
 * Rule-added stages are looked up among the rules rather than the route, because
 * that is where they are declared; a route lookup would always miss them.
 */
export function resolveStageModel(
  source: StageModelSource,
  routeId: string,
  stage: Pick<TaskStage, "id" | "model" | "addedByRule">,
): string | undefined {
  const configured = stage.addedByRule
    ? findRuleStageModel(source.rules, stage.id)
    : findRouteStageModel(source.routes, routeId, stage.id);

  // `found` distinguishes "config says no override" from "stage is not in config
  // any more". The first must clear a stale model; the second must not touch it.
  if (!configured.found) return stage.model;
  return configured.model;
}

function findRouteStageModel(
  routes: readonly RouteDefinition[],
  routeId: string,
  stageId: string,
): { found: boolean; model?: string } {
  const route = routes.find((r) => r.id === routeId);
  if (!route) return { found: false };
  const definition = route.stages.find((s) => s.id === stageId);
  if (!definition) return { found: false };
  return { found: true, model: normalize(definition.model) };
}

function findRuleStageModel(
  rules: readonly ReviewRule[],
  stageId: string,
): { found: boolean; model?: string } {
  const rule = rules.find((r) => r.stage.id === stageId);
  if (!rule) return { found: false };
  return { found: true, model: normalize(rule.stage.model) };
}

/** A blank model in config means "no override", not a model named "". */
function normalize(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}
