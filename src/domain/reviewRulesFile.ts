import { ReviewRule, ReviewStageTemplate } from "./reviewRules";
import { StageKind } from "./taskRoute";

/**
 * Parsing and validation for a project's review-rules file.
 *
 * Rules are per-project by definition: what a `.sql` change obliges you to
 * verify is a property of *that* codebase and *that* team, so the rule set
 * belongs in the repository, committed and reviewed like any other code. The
 * extension ships defaults only as a starting point.
 *
 * Parsing is pure and total: a malformed file yields problems alongside
 * whatever rules were salvageable, never an exception. A typo in a rules file
 * must not stop the extension from listing your tasks.
 */

/** Conventional location, relative to the repository root. */
export const REVIEW_RULES_RELATIVE_PATH = ".taskworkspaces/review-rules.json";

export interface ReviewRulesFile {
  /**
   * Accepted for forward compatibility and to keep existing files valid. The
   * extension ships no rules of its own, so both values now behave identically:
   * a project's rules are the only rules. Kept so a file written earlier does
   * not start reporting problems.
   */
  extends?: "default" | "none";
  rules?: unknown[];
}

export interface ParsedReviewRules {
  rules: ReviewRule[];
  /** Human-readable validation failures, for the log and a UI warning. */
  problems: string[];
}

/**
 * Stage kinds a rule may contribute. A rule adds *verification*, so it may not
 * inject implementation work, and may not add a second terminal gate — the
 * route owns those.
 */
const ALLOWED_RULE_STAGE_KINDS: readonly StageKind[] = [
  "test",
  "codeReview",
  "domainReview",
  "behaviourReview",
];

/**
 * Parses the contents of a review-rules file. Accepts either the envelope
 * (`{ extends, rules }`) or a bare array of rules, which is the shape people
 * write first.
 */
export function parseReviewRules(raw: unknown): ParsedReviewRules {
  const problems: string[] = [];

  let entries: unknown[];

  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === "object") {
    const file = raw as ReviewRulesFile;
    if (
      file.extends !== undefined &&
      file.extends !== "none" &&
      file.extends !== "default"
    ) {
      problems.push(
        `"extends" must be "default" or "none"; got ${JSON.stringify(file.extends)}. Ignoring it.`,
      );
    }
    if (file.rules === undefined) {
      entries = [];
    } else if (Array.isArray(file.rules)) {
      entries = file.rules;
    } else {
      problems.push('"rules" must be an array.');
      entries = [];
    }
  } else {
    problems.push(
      `Review rules must be an object or an array; got ${raw === null ? "null" : typeof raw}.`,
    );
    // No rules can be salvaged from a wholly wrong shape. Returning none is
    // honest; the caller reports the problem loudly rather than pretending the
    // project has requirements it does not.
    return { rules: [], problems };
  }

  const projectRules: ReviewRule[] = [];
  const seenRuleIds = new Set<string>();
  const seenStageIds = new Set<string>();

  entries.forEach((entry, index) => {
    const parsed = parseRule(entry, index, problems);
    if (!parsed) return;
    if (seenRuleIds.has(parsed.id)) {
      problems.push(`Rule ${describe(index)}: duplicate rule id "${parsed.id}"; ignoring.`);
      return;
    }
    if (seenStageIds.has(parsed.stage.id)) {
      problems.push(
        `Rule ${describe(index)}: stage id "${parsed.stage.id}" is already used; ignoring.`,
      );
      return;
    }
    seenRuleIds.add(parsed.id);
    seenStageIds.add(parsed.stage.id);
    projectRules.push(parsed);
  });

  return { rules: projectRules, problems };
}

/**
 * Layers overrides onto a base set. An override with the same rule id replaces
 * the base rule in place, keeping evaluation order stable; anything else is
 * appended. Order matters because it decides the sequence of review stages.
 */
export function mergeRules(
  base: readonly ReviewRule[],
  overrides: readonly ReviewRule[],
): ReviewRule[] {
  const byId = new Map(overrides.map((rule) => [rule.id, rule]));
  const merged = base.map((rule) => byId.get(rule.id) ?? rule);
  const usedStageIds = new Set(merged.map((r) => r.stage.id));

  for (const rule of overrides) {
    if (base.some((b) => b.id === rule.id)) continue;
    // A project rule reusing a built-in's stage id would collide in the
    // pipeline, where stage ids must be unique.
    if (usedStageIds.has(rule.stage.id)) continue;
    usedStageIds.add(rule.stage.id);
    merged.push(rule);
  }
  return merged;
}

function parseRule(
  entry: unknown,
  index: number,
  problems: string[],
): ReviewRule | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    problems.push(`Rule ${describe(index)}: expected an object.`);
    return undefined;
  }
  const raw = entry as Record<string, unknown>;

  const id = str(raw.id);
  if (!id) {
    problems.push(`Rule ${describe(index)}: "id" is required.`);
    return undefined;
  }
  const pathPattern = str(raw.pathPattern);
  if (!pathPattern) {
    problems.push(`Rule "${id}": "pathPattern" is required.`);
    return undefined;
  }
  try {
    new RegExp(pathPattern, "i");
  } catch (error) {
    problems.push(
      `Rule "${id}": "pathPattern" is not a valid regular expression (${(error as Error).message}).`,
    );
    return undefined;
  }

  // An unusable exclusion is dropped, not fatal: failing towards *more*
  // verification is the safe direction, and the problem is still reported.
  let exceptPattern = str(raw.exceptPattern);
  if (exceptPattern) {
    try {
      new RegExp(exceptPattern, "i");
    } catch (error) {
      problems.push(
        `Rule "${id}": "exceptPattern" is not a valid regular expression ` +
          `(${(error as Error).message}); ignoring the exclusion.`,
      );
      exceptPattern = undefined;
    }
  }

  const stage = parseStage(raw.stage, id, problems);
  if (!stage) return undefined;

  return {
    id,
    reason: str(raw.reason) ?? `Matched rule "${id}".`,
    pathPattern,
    ...(exceptPattern ? { exceptPattern } : {}),
    stage,
  };
}

function parseStage(
  entry: unknown,
  ruleId: string,
  problems: string[],
): ReviewStageTemplate | undefined {
  if (!entry || typeof entry !== "object") {
    problems.push(`Rule "${ruleId}": "stage" is required.`);
    return undefined;
  }
  const raw = entry as Record<string, unknown>;

  const id = str(raw.id);
  const label = str(raw.label);
  const intent = str(raw.intent);
  if (!id || !label || !intent) {
    problems.push(`Rule "${ruleId}": stage needs "id", "label" and "intent".`);
    return undefined;
  }

  const kind = str(raw.kind);
  if (!kind || !ALLOWED_RULE_STAGE_KINDS.includes(kind as StageKind)) {
    problems.push(
      `Rule "${ruleId}": stage "kind" must be one of ${ALLOWED_RULE_STAGE_KINDS.join(", ")}; got ${JSON.stringify(raw.kind)}.`,
    );
    return undefined;
  }

  const gate = str(raw.gate);
  if (gate !== undefined && gate !== "auto" && gate !== "approval") {
    problems.push(`Rule "${ruleId}": stage "gate" must be "auto" or "approval".`);
    return undefined;
  }

  return {
    id,
    label,
    kind: kind as StageKind,
    intent,
    workflow: str(raw.workflow),
    model: str(raw.model),
    splittable: typeof raw.splittable === "boolean" ? raw.splittable : undefined,
    gate: gate as "auto" | "approval" | undefined,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function describe(index: number): string {
  return `at index ${index}`;
}

// Starter files live in ./reviewRuleTemplates — they are copied into a project
// on request, never applied implicitly.
