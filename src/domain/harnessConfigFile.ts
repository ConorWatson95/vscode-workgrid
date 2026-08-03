import { ReviewRule } from "./reviewRules";
import { parseReviewRules } from "./reviewRulesFile";
import {
  RouteDefinition,
  RouteStageDefinition,
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

  return {
    id,
    label,
    kind: kind as StageKind,
    intent,
    workflow: str(raw.workflow),
    splittable: raw.splittable === true,
    gate: gate as StageGate,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
