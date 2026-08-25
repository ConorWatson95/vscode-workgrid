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

/**
 * The model an *amendment* subtask should run on, when a cheaper one is configured.
 *
 * Measured on 25 Aug 2026: amendments were **$63.86 of the day's $101.68 — 63%, across
 * 165 sessions** at $0.39 each, and $50.63 of that ran on Opus. On one task, 29 of 32
 * amendments wrote no file at all: what they did was read a finding, go and look, and
 * report "nothing in this stage's output changes". That is not work a frontier model is
 * needed for, and it is the largest single line in the harness's bill.
 *
 * **Amendments only, never a correction.** The distinction `Subtask.correction.upstream`
 * exists to keep is exactly the one that matters here: a correction is the stage getting
 * its own work wrong and being asked to fix it — real work, on the stage's own terms — and
 * an amendment is being told the ground moved and asked whether anything follows. Running
 * a correction cheaper would be economising on the thing that produces the output.
 *
 * **Absent means inherit**, so nothing changes until it is configured. A model is not a
 * timeout: quietly moving execution to a cheaper tier is a change to how the work is
 * done, and the harness must not make that choice on an operator's behalf.
 *
 * Deliberately one value rather than per kind or per stage. The rule being expressed is
 * about the *shape of the task* — a narrow, bounded "does this still hold?" — which is
 * the same shape whatever stage is answering it, and a per-stage surface would need a
 * reason to differ that nothing here has.
 */
export function resolveAmendmentModel(
  configured: string | undefined,
  subtask: { correction?: { upstream?: unknown } },
  stageModel: string | undefined,
): string | undefined {
  const cheap = configured?.trim();
  if (!cheap) return stageModel;
  return subtask.correction?.upstream ? cheap : stageModel;
}
