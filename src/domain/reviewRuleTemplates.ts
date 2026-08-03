import { BEHAVIOUR_REVIEW_BRIEF, ReviewRule } from "./reviewRules";
import { BUILT_IN_ROUTES } from "./taskRoute";

/**
 * Starter rule sets, offered when a project creates its rules file.
 *
 * These are **templates, not defaults**. The extension applies no rules of its
 * own: which changes oblige which reviews is a property of a specific codebase
 * and team, so a project that has not written rules requires none. Shipping
 * one team's rules as everyone's defaults would impose that team's assumptions
 * on every repository the extension is opened on.
 *
 * Templates are written to disk for the user to edit, so they are worth being
 * opinionated — once copied, they are the project's, not ours.
 */

export interface RuleTemplate {
  id: string;
  label: string;
  description: string;
  rules: readonly ReviewRule[];
}

/**
 * Test and fixture paths. Behaviour reviews exist to tell a human what to
 * exercise in a running build; a change confined to test code has nothing for
 * them to click, and an unwarranted checklist trains people to rubber-stamp the
 * gate. Applied to the behaviour-flavoured rules, not the domain ones — a SQL
 * change inside a test project can still be worth a SQL review.
 */
const TEST_PATHS =
  "(?:^|/)(?:tests?|spec|__tests__|fixtures?)/|\\.tests?\\.|\\.spec\\.|_test\\.";

/**
 * Matches a path segment at the start of a path or after a slash. Patterns must
 * not require a *leading* slash: `Controllers/Foo.cs` at the repository root is
 * as common as `src/Controllers/Foo.cs`, and requiring the slash silently misses
 * every top-level directory.
 */
const SEG = "(?:^|/)";

/** Language-neutral: only what is defensible in almost any repository. */
const MINIMAL_RULES: readonly ReviewRule[] = [
  {
    id: "sql",
    reason: "SQL or stored procedures changed.",
    pathPattern: `\\.sql$|${SEG}stored[-_ ]?procedures?/`,
    stage: {
      id: "sql-review",
      label: "SQL review",
      kind: "domainReview",
      intent:
        "Review the SQL changes for query correctness, index usage, migration " +
        "safety on existing data, and whether any change alters result sets.",
    },
  },
];

/**
 * .NET / enterprise line-of-business flavour. Written for a codebase with
 * AutoMapper profiles, stored procedures, RDL reports and Razor views.
 */
const DOTNET_RULES: readonly ReviewRule[] = [
  ...MINIMAL_RULES,
  {
    id: "mapping-profile",
    reason: "An object-mapping profile changed.",
    pathPattern: `${SEG}mapp(?:er|ing)s?/|automapper|profiles?\\.cs$`,
    exceptPattern: TEST_PATHS,
    stage: {
      id: "mapping-behaviour-review",
      label: "Mapping behaviour review",
      kind: "behaviourReview",
      intent:
        BEHAVIOUR_REVIEW_BRIEF +
        " Mapping changes silently alter data in every consumer of the mapped " +
        "type, so enumerate the downstream consumers explicitly: editing an " +
        "existing record, exports, related lookups and any reporting that " +
        "reads these fields.",
    },
  },
  {
    id: "api-contract",
    reason: "An API contract changed.",
    pathPattern: `${SEG}(?:controllers?|api|dtos?|contracts?)/|\\.proto$|openapi|swagger`,
    stage: {
      id: "compatibility-review",
      label: "Compatibility review",
      kind: "domainReview",
      intent:
        "Determine whether this change is backward compatible for existing " +
        "callers. Flag removed or renamed fields, tightened validation, and " +
        "changed status codes or nullability.",
    },
  },
  {
    id: "authentication",
    reason: "Authentication or authorisation code changed.",
    pathPattern: `${SEG}(?:auth[a-z]*|identity|security)/|\\blogin\\b|\\btokens?\\b|\\bpermissions?\\b|\\broles?\\b`,
    stage: {
      id: "security-review",
      label: "Security review",
      kind: "domainReview",
      intent:
        "Review for authentication and authorisation defects: missing checks, " +
        "privilege escalation, token handling and leakage of credentials.",
      workflow: "/security-review",
    },
  },
  {
    id: "reporting",
    reason: "Reporting or export code changed.",
    pathPattern: `${SEG}(?:reports?|reporting|exports?)/|\\.rdl$`,
    exceptPattern: TEST_PATHS,
    stage: {
      id: "result-shape-validation",
      label: "Result-shape validation",
      kind: "behaviourReview",
      intent:
        BEHAVIOUR_REVIEW_BRIEF +
        " Focus on the shape of results: column order and headings, totals and " +
        "subtotals, rounding, date and currency formatting, and empty-result " +
        "handling.",
    },
  },
  {
    id: "ui",
    reason: "User-facing UI changed.",
    pathPattern: `\\.(?:razor|cshtml|aspx)$|${SEG}views/`,
    exceptPattern: TEST_PATHS,
    stage: {
      id: "ui-smoke-test",
      label: "UI smoke test",
      kind: "behaviourReview",
      intent:
        BEHAVIOUR_REVIEW_BRIEF +
        " Cover the visible surface: the affected screens render, interactive " +
        "controls respond, and validation messages still appear correctly.",
    },
  },
];

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: "minimal",
    label: "Minimal",
    description: "One rule: SQL changes require a SQL review. A starting point to edit.",
    rules: MINIMAL_RULES,
  },
  {
    id: "dotnet",
    label: ".NET line-of-business",
    description:
      "Mapping profiles, API contracts, auth, reporting and Razor views — for an enterprise C# codebase.",
    rules: DOTNET_RULES,
  },
];

export function findRuleTemplate(id: string): RuleTemplate | undefined {
  return RULE_TEMPLATES.find((template) => template.id === id);
}

/**
 * Renders a template as an annotated rules file. Comments are included because
 * the reason a rule exists is the valuable part, and the loader tolerates them.
 */
export function renderRuleTemplate(template: RuleTemplate): string {
  // Routes are seeded from the built-ins so the first edit is a change to a real
  // workflow rather than authoring one from a blank page. Once this file defines
  // routes, these are the only routes offered — the built-ins stop applying.
  const body = JSON.stringify(
    { routes: BUILT_IN_ROUTES, rules: template.rules },
    null,
    2,
  );
  return `// Harness config for this project: the routes work travels through, and the
// reviews a change obliges.
//
// "routes" replaces the extension's built-in routes entirely once present. Each
// route needs at least one stage with "gate": "approval" so it cannot mark itself
// complete. Stage "kind" is one of implementation, test, codeReview, domainReview,
// behaviourReview, humanVerification. Set "splittable": true on a stage a planning
// agent should break into subtasks.
//
// Each rule maps changed file paths to a review the change therefore requires.
// "pathPattern" is a case-insensitive regular expression matched against paths
// relative to the repository root, using forward slashes.
//
// "exceptPattern" (optional) excludes paths that would otherwise match — used
// here to keep test-only changes from demanding a manual behaviour checklist.
// If it is malformed it is ignored, so a typo cannot silently drop a review.
//
// Rules are read from the repository root, never from a task worktree, so a
// branch cannot relax the reviews it is subject to. Edit this file on your base
// branch.
//
// Template: ${template.label} — ${template.description}
${body}
`;
}
