import { ReviewRule } from "./reviewRules";
import { parseReviewRules } from "./reviewRulesFile";
import { parseSuggestionSources, SuggestionSource } from "./suggestionSourceFile";
import {
  ALL_STAGE_KINDS,
  ChecklistAudience,
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
  // Neither planning nor deployment may come from a rule: a rule adds
  // verification, and both of these are the route lifecycle's own business.
  "planning",
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
  /**
   * Where this project keeps work worth suggesting. Empty means it declared none, and
   * unlike routes there is no fallback: which board matters is a property of a team,
   * so a project with no sources is offered no suggestions rather than a guess.
   */
  suggestions: SuggestionSource[];
  /**
   * Tracked paths that are local environment rather than work, restored before a stage's
   * check reads the tree. See `domain/worktreeDiscard.ts` for what that costs and why it
   * is a discard rather than an exclusion.
   *
   * Read from the **repository root** like the rest of this file, which is what stops a
   * branch adding its own files to the list and having them deleted on the way past a
   * gate. Empty means the project declared none, and nothing is ever discarded — the
   * same no-fallback rule as rules and suggestions, and for a stronger reason: a default
   * here destroys files.
   */
  discardPaths: string[];
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
  let suggestions: SuggestionSource[] = [];
  let discardPaths: string[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    discardPaths = parseDiscardPaths((raw as { worktree?: unknown }).worktree, problems);

    const routesField = (raw as { routes?: unknown }).routes;
    if (routesField !== undefined) {
      if (Array.isArray(routesField)) {
        routes = parseRoutes(routesField, problems);
      } else {
        problems.push('"routes" must be an array.');
      }
    }

    const parsedSources = parseSuggestionSources(
      (raw as { suggestions?: unknown }).suggestions,
    );
    suggestions = parsedSources.sources;
    problems.push(...parsedSources.problems);
  }

  return { routes, rules: rulesResult.rules, suggestions, discardPaths, problems };
}

/**
 * Reads `worktree.discardPaths`.
 *
 * Every malformed shape is **rejected outright rather than partially accepted**, which
 * is the opposite of how routes and sources are parsed. The difference is what a wrong
 * answer costs: a skipped route is a picker entry that does not appear, while a
 * misread discard path is a file deleted from someone's worktree. Where partial
 * acceptance would have to guess, this stops.
 *
 * An absolute path or one climbing out of the repository is refused for the same
 * reason `worktreePath` is normalised — the list is repository-relative, and anything
 * else is either a mistake or an attempt to reach a file outside the checkout.
 */
function parseDiscardPaths(worktree: unknown, problems: string[]): string[] {
  if (worktree === undefined) return [];
  if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) {
    problems.push('"worktree" must be an object.');
    return [];
  }
  const field = (worktree as { discardPaths?: unknown }).discardPaths;
  if (field === undefined) return [];
  const paths = strList(field);
  if (!paths) {
    problems.push('"worktree.discardPaths" must be an array of repository-relative paths.');
    return [];
  }

  const kept: string[] = [];
  for (const entry of paths) {
    const path = entry.trim().replace(/\\/g, "/");
    if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
      problems.push(
        `"worktree.discardPaths" entry "${entry}" is absolute; paths are relative to ` +
          "the repository root.",
      );
      continue;
    }
    if (path.split("/").includes("..")) {
      problems.push(
        `"worktree.discardPaths" entry "${entry}" climbs outside the repository.`,
      );
      continue;
    }
    kept.push(path);
  }
  return kept;
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

  const requiredMcpServers = strList(raw.requiredMcpServers);
  if (raw.requiredMcpServers !== undefined && requiredMcpServers === undefined) {
    problems.push(
      `Route "${routeId}" stage "${id}": "requiredMcpServers" must be an array of MCP server names.`,
    );
    return undefined;
  }

  // Only meaningful on a verification gate. Rejected elsewhere rather than ignored: a
  // scope declared on, say, a deployment stage looks like it works and silently sends
  // every item tagged with it to the fallback gate instead, which is a route quietly
  // verifying things in the wrong place.
  const checklistScope = str(raw.checklistScope);
  if (checklistScope !== undefined && kind !== "humanVerification") {
    problems.push(
      `Route "${routeId}" stage "${id}": "checklistScope" only applies to a ` +
        `"humanVerification" stage, and this one is "${kind}".`,
    );
    return undefined;
  }

  // Same reasoning as the scope above, and one more: an audience misread as absent
  // defaults to "self", so a typo puts a task waiting on external testers back into
  // the operator's own list — the exact thing the field exists to stop. Rejected
  // rather than defaulted.
  const checklistAudience = str(raw.checklistAudience);
  if (checklistAudience !== undefined && kind !== "humanVerification") {
    problems.push(
      `Route "${routeId}" stage "${id}": "checklistAudience" only applies to a ` +
        `"humanVerification" stage, and this one is "${kind}".`,
    );
    return undefined;
  }
  if (checklistAudience !== undefined && checklistAudience !== "self" && checklistAudience !== "others") {
    problems.push(
      `Route "${routeId}" stage "${id}": "checklistAudience" must be "self" or ` +
        `"others", not "${checklistAudience}".`,
    );
    return undefined;
  }

  // Rejected rather than coerced, unlike `handoff` and `mayChangeBranch` above, and the
  // asymmetry is deliberate: those read a non-boolean as absent, which merely turns an
  // enhancement off. A `requiresPullRequest` misread as absent turns off the check that
  // a promotion stage actually opened the pull request it was told to — and the whole
  // reason that check exists is that its absence is invisible until a human is asked to
  // merge something nobody created.
  if (raw.requiresPullRequest !== undefined && typeof raw.requiresPullRequest !== "boolean") {
    problems.push(
      `Route "${routeId}" stage "${id}": "requiresPullRequest" must be true or false.`,
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
    ...(checklistScope ? { checklistScope } : {}),
    ...(checklistAudience ? { checklistAudience: checklistAudience as ChecklistAudience } : {}),
    ...(raw.requiresPullRequest === true ? { requiresPullRequest: true } : {}),
    ...(raw.handoff === true ? { handoff: true } : {}),
    ...(raw.mayChangeBranch === true ? { mayChangeBranch: true } : {}),
    ...(str(raw.verify) ? { verify: str(raw.verify) } : {}),
    ...(str(raw.planFile) ? { planFile: str(raw.planFile) } : {}),
    ...(str(raw.planOutput) ? { planOutput: str(raw.planOutput) } : {}),
    ...(sendBackTo ? { sendBackTo } : {}),
    ...(requiredMcpServers && requiredMcpServers.length > 0 ? { requiredMcpServers } : {}),
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
