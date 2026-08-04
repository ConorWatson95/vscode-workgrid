import { ReviewRule } from "./reviewRules";
import { parseReviewRules } from "./reviewRulesFile";
import {
  ALL_STAGE_KINDS,
  looksLikeKindEntry,
  RouteDefinition,
  RouteStageDefinition,
  sendBackEntryKind,
  StageGate,
  StageKind,
} from "./taskRoute";

/**
 * Parsing for a project's harness config: `.taskworkspaces/harness.json`.
 *
 * Holds both halves of the harness because they are one decision:
 * `routes` — the stages a kind of work must travel through — and `rules` — the
 * reviews a diff obliges on top of them. Both are team process, so both belong
 * in one reviewed, committed file rather than in editor settings.
 *
 * Pure and total: a malformed entry is reported and skipped, never thrown.
 */

/** Every stage kind a route may declare. Routes own the whole lifecycle. */
const ROUTE_STAGE_KINDS: readonly StageKind[] = [
  "implementation",
  // A rule may not contribute one: shipping work is the route lifecycle's job.
  "deployment",
  "test",
  "codeReview",
  "domainReview",
  "behaviourReview",
  "humanVerification",
];

export interface ParsedHarnessConfig {
  /**
   * Routes the project defined. Empty means it defined none, and the caller
   * falls back to the built-ins — a route is process scaffolding, so a usable
   * default is better than an empty picker.
   */
  routes: RouteDefinition[];
  rules: ReviewRule[];
  problems: string[];
}

/**
 * Parses a harness config. Also accepts a rules-only file — either the
 * `{ rules: [...] }` envelope or a bare array — so a `review-rules.json` written
 * before routes were configurable keeps working.
 */
export function parseHarnessConfig(raw: unknown): ParsedHarnessConfig {
  const rulesResult = parseReviewRules(raw);
  const problems = [...rulesResult.problems];

  let routes: RouteDefinition[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const routesField = (raw as { routes?: unknown }).routes;
    if (routesField !== undefined) {
      if (Array.isArray(routesField)) {
        routes = parseRoutes(routesField, problems);
      } else {
        problems.push('"routes" must be an array.');
      }
    }
  }

  return { routes, rules: rulesResult.rules, problems };
}

function parseRoutes(entries: unknown[], problems: string[]): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const route = parseRoute(entry, index, problems);
    if (!route) return;
    if (seen.has(route.id)) {
      problems.push(`Route "${route.id}": duplicate id; ignoring the later one.`);
      return;
    }
    seen.add(route.id);
    routes.push(route);
  });

  return routes;
}

function parseRoute(
  entry: unknown,
  index: number,
  problems: string[],
): RouteDefinition | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    problems.push(`Route at index ${index}: expected an object.`);
    return undefined;
  }
  const raw = entry as Record<string, unknown>;

  const id = str(raw.id);
  const label = str(raw.label);
  if (!id || !label) {
    problems.push(`Route at index ${index}: "id" and "label" are required.`);
    return undefined;
  }
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    problems.push(`Route "${id}": needs a non-empty "stages" array.`);
    return undefined;
  }

  const stages: RouteStageDefinition[] = [];
  const seenStageIds = new Set<string>();
  for (const [stageIndex, stageEntry] of raw.stages.entries()) {
    const stage = parseStage(stageEntry, id, stageIndex, problems);
    if (!stage) return undefined;
    if (seenStageIds.has(stage.id)) {
      problems.push(`Route "${id}": duplicate stage id "${stage.id}".`);
      return undefined;
    }
    seenStageIds.add(stage.id);
    stages.push(stage);
  }

  // A route with no human gate could declare itself finished. The whole point of
  // the harness is that something outside the model signs off, so this is the one
  // structural requirement placed on a project's own routes.
  if (!stages.some((stage) => stage.gate === "approval")) {
    problems.push(
      `Route "${id}": must end at a stage with "gate": "approval", so it cannot ` +
        "mark itself complete. Ignoring the route.",
    );
    return undefined;
  }

  if (!checkSendBackTargets(id, stages, problems)) return undefined;

  return {
    id,
    label,
    description: str(raw.description) ?? label,
    stages,
  };
}

function parseStage(
  entry: unknown,
  routeId: string,
  index: number,
  problems: string[],
): RouteStageDefinition | undefined {
  if (!entry || typeof entry !== "object") {
    problems.push(`Route "${routeId}" stage ${index}: expected an object.`);
    return undefined;
  }
  const raw = entry as Record<string, unknown>;

  const id = str(raw.id);
  const label = str(raw.label);
  const intent = str(raw.intent);
  if (!id || !label || !intent) {
    problems.push(
      `Route "${routeId}" stage ${index}: "id", "label" and "intent" are required.`,
    );
    return undefined;
  }

  const kind = str(raw.kind);
  if (!kind || !ROUTE_STAGE_KINDS.includes(kind as StageKind)) {
    problems.push(
      `Route "${routeId}" stage "${id}": "kind" must be one of ${ROUTE_STAGE_KINDS.join(", ")}.`,
    );
    return undefined;
  }

  const gate = str(raw.gate) ?? "auto";
  if (gate !== "auto" && gate !== "approval") {
    problems.push(
      `Route "${routeId}" stage "${id}": "gate" must be "auto" or "approval".`,
    );
    return undefined;
  }

  const sendBackTo = strList(raw.sendBackTo);
  if (raw.sendBackTo !== undefined && sendBackTo === undefined) {
    problems.push(
      `Route "${routeId}" stage "${id}": "sendBackTo" must be an array of stage ids.`,
    );
    return undefined;
  }

  return {
    id,
    label,
    kind: kind as StageKind,
    intent,
    workflow: str(raw.workflow),
    model: str(raw.model),
    splittable: raw.splittable === true,
    gate: gate as StageGate,
    ...(sendBackTo ? { sendBackTo } : {}),
  };
}

/**
 * Rejects a route whose `sendBackTo` names a stage that is missing, is itself, or
 * comes later.
 *
 * Checked across the whole route rather than per stage because that is the only
 * place the ordering is known — and it is the ordering that makes the difference
 * between "send this back to be reimplemented" and a cycle. A stage allowed to
 * send work forward, or to itself, could loop a route indefinitely, so it is
 * refused at load rather than guarded at every use.
 */
function checkSendBackTargets(
  routeId: string,
  stages: readonly RouteStageDefinition[],
  problems: string[],
): boolean {
  let ok = true;
  stages.forEach((stage, index) => {
    for (const target of stage.sendBackTo ?? []) {
      if (looksLikeKindEntry(target)) {
        // A kind entry matches whatever earlier stage has that kind, so there is no
        // ordering to check — only the spelling, since a misspelled kind silently
        // matches nothing and looks exactly like the feature not working.
        if (!sendBackEntryKind(target)) {
          problems.push(
            `Route "${routeId}" stage "${stage.id}": "sendBackTo" names ` +
              `"${target}", which is not a stage kind. Expected one of ` +
              ALL_STAGE_KINDS.map((kind) => `kind:${kind}`).join(", "),
          );
          ok = false;
        }
        continue;
      }
      const targetIndex = stages.findIndex((s) => s.id === target);
      if (targetIndex === -1) {
        problems.push(
          `Route "${routeId}" stage "${stage.id}": "sendBackTo" names "${target}", ` +
            "which is not a stage of this route.",
        );
        ok = false;
      } else if (targetIndex >= index) {
        problems.push(
          `Route "${routeId}" stage "${stage.id}": "sendBackTo" names "${target}", ` +
            "which is not an earlier stage. Sending work forward, or to itself, " +
            "would let the route loop.",
        );
        ok = false;
      }
    }
  });
  return ok;
}

/**
 * A list of non-empty strings, or undefined when the value is not one.
 *
 * Distinguishes "not an array of ids" from "an empty list": the first is a
 * mistake worth reporting, the second is a stage deliberately allowing nothing.
 */
function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((entry) => str(entry)).filter((entry): entry is string => !!entry);
  return items.length === value.length ? items : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
