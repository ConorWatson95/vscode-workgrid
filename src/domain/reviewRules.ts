import { RouteStageDefinition, StageKind } from "./taskRoute";

/**
 * The rules engine: a decision table mapping *what a change touched* to *which
 * reviews it therefore requires*.
 *
 * This is the part a model cannot infer. That editing a mapping profile ought to
 * trigger a manual check of record editing, exports and downstream reporting is
 * team knowledge, not a model capability — so it lives as data, is
 * version-controlled, and is reviewed like any other code.
 *
 * **The extension ships no rules of its own.** Which changes oblige which
 * reviews is a property of a specific codebase, so a project that has not
 * written rules requires none. Starter sets live in ./reviewRuleTemplates and
 * are copied into a project on request, never applied implicitly — otherwise one
 * team's assumptions would be imposed on every repository.
 *
 * Rules are evaluated against changed file paths, which means they can only be
 * applied once a diff exists. That is deliberate: at task-creation time nobody
 * knows whether a bug fix will end up touching SQL.
 */

export interface ReviewRule {
  id: string;
  /** Shown when explaining why a stage was added. */
  reason: string;
  /**
   * Case-insensitive regular expression source, matched against each changed
   * path (forward-slash normalised). A string rather than a RegExp so rule sets
   * stay JSON-serialisable and user-configurable.
   */
  pathPattern: string;
  /**
   * Optional exclusion, applied after `pathPattern`: a path matching this is not
   * counted as a trigger. Exists because path matching alone over-fires — a test
   * file under `Mapping/` matches a mapping rule but needs no manual behaviour
   * verification, and an unwarranted human checklist is the fastest way to teach
   * people to rubber-stamp the gate.
   */
  exceptPattern?: string;
  /**
   * The review stage this rule requires. Behaviour-flavoured stages leave the
   * gate on "auto": they *raise* verification items rather than settling them,
   * and the terminal human-verification gate is the single place that refuses
   * to advance while any item is outstanding.
   */
  stage: ReviewStageTemplate;
}

/** A stage a rule can contribute. Ids must be unique across a rule set. */
export interface ReviewStageTemplate {
  id: string;
  label: string;
  kind: StageKind;
  intent: string;
  workflow?: string;
  /** Model for this review stage, overriding the configured default. */
  model?: string;
  splittable?: boolean;
  /** Defaults to "auto"; a rule can demand a human gate of its own. */
  gate?: "auto" | "approval";
  /**
   * Stages this review may send its findings back to — see
   * `RouteStageDefinition.sendBackTo`.
   *
   * In a rule this is almost always the `kind:` form. A rule is written once and
   * splices into any route whose diff matches it, so it cannot know what those
   * routes call their stages; `kind:implementation` means "whatever produced the
   * code I just reviewed" and resolves correctly wherever the rule lands.
   */
  sendBackTo?: readonly string[];
}

/**
 * The prompt pattern that makes a behaviour review useful: it recasts the agent
 * from judge to QA planner. Reused by every behaviour-flavoured rule so the
 * framing stays consistent.
 */
export const BEHAVIOUR_REVIEW_BRIEF =
  "Review this implementation from the perspective of runtime behaviour. " +
  "Ignore code style. Assume the code compiles and unit tests pass. " +
  "Identify places where manual verification is required because correctness " +
  "depends on business behaviour rather than static analysis. " +
  "Produce a checklist for a human tester, each item naming the screen or " +
  "endpoint to exercise and the result that would indicate a regression.";

/**
 * The rule set applied when a project has defined none: empty.
 *
 * Named rather than inlined so the intent is explicit at every call site — this
 * is a deliberate "no requirements" answer, not an accidentally missing default.
 */
export const NO_REVIEW_RULES: readonly ReviewRule[] = [];

export interface RuleMatch {
  rule: ReviewRule;
  /** Changed paths that triggered it, for explaining the decision. */
  matchedPaths: string[];
}

/**
 * Evaluates a rule set against changed paths. Returns one match per rule in
 * rule-set order, regardless of how many paths triggered it, so a change
 * touching twelve SQL files still yields a single SQL review.
 *
 * An invalid `pathPattern` is skipped rather than thrown: a malformed
 * user-supplied rule should not take down reconciliation for every task.
 *
 * An invalid `exceptPattern` is *ignored* rather than skipping the rule, so a
 * typo in an exclusion cannot silently drop a review requirement — it fails
 * towards requiring more verification, not less.
 */
export function evaluateRules(
  changedPaths: readonly string[],
  rules: readonly ReviewRule[] = NO_REVIEW_RULES,
): RuleMatch[] {
  const normalised = changedPaths.map((p) => p.replace(/\\/g, "/"));
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.pathPattern, "i");
    } catch {
      continue;
    }

    let exclude: RegExp | undefined;
    if (rule.exceptPattern) {
      try {
        exclude = new RegExp(rule.exceptPattern, "i");
      } catch {
        exclude = undefined;
      }
    }

    const matchedPaths = normalised.filter(
      (p) => pattern.test(p) && !exclude?.test(p),
    );
    if (matchedPaths.length > 0) {
      matches.push({ rule, matchedPaths });
    }
  }

  return matches;
}

/** Converts a rule's template into a full stage definition. */
export function ruleStageDefinition(rule: ReviewRule): RouteStageDefinition {
  return {
    id: rule.stage.id,
    label: rule.stage.label,
    kind: rule.stage.kind,
    intent: rule.stage.intent,
    workflow: rule.stage.workflow,
    model: rule.stage.model,
    splittable: rule.stage.splittable ?? false,
    gate: rule.stage.gate ?? "auto",
    ...(rule.stage.sendBackTo && rule.stage.sendBackTo.length > 0
      ? { sendBackTo: rule.stage.sendBackTo }
      : {}),
  };
}
