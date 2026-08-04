import { describe, it, expect } from "vitest";
import { mergeRules, parseReviewRules } from "./reviewRulesFile";
import { ReviewRule } from "./reviewRules";
import { RULE_TEMPLATES, renderRuleTemplate } from "./reviewRuleTemplates";
import { stripJsonComments } from "../services/reviewRulesService";
import { parseHarnessConfig } from "./harnessConfigFile";
import { BUILT_IN_ROUTES } from "./taskRoute";

const VALID = {
  id: "dealer-config",
  reason: "Dealer configuration changed.",
  pathPattern: "dealer.*config",
  stage: {
    id: "dealer-config-review",
    label: "Dealer config review",
    kind: "domainReview",
    intent: "Check every dealer-specific override still resolves.",
  },
};

describe("parseReviewRules", () => {
  it("yields exactly the project's rules, with nothing layered in", () => {
    // The extension contributes no rules, so a project's file is the whole set.
    const parsed = parseReviewRules({ rules: [VALID] });
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules.map((r) => r.id)).toEqual(["dealer-config"]);
  });

  it("treats both extends values identically, keeping older files valid", () => {
    for (const value of ["none", "default"] as const) {
      const parsed = parseReviewRules({ extends: value, rules: [VALID] });
      expect(parsed.rules.map((r) => r.id), value).toEqual(["dealer-config"]);
      expect(parsed.problems, value).toEqual([]);
    }
  });

  it("accepts a bare array, which is what people write first", () => {
    const parsed = parseReviewRules([VALID]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules.some((r) => r.id === "dealer-config")).toBe(true);
  });

  it("preserves rule order as written, since order decides review sequence", () => {
    const second = { ...VALID, id: "b", stage: { ...VALID.stage, id: "b-review" } };
    const parsed = parseReviewRules({ rules: [VALID, second] });
    expect(parsed.rules.map((r) => r.id)).toEqual(["dealer-config", "b"]);
  });

  it("defaults a missing reason rather than rejecting the rule", () => {
    const { reason, ...withoutReason } = VALID;
    const parsed = parseReviewRules({ extends: "none", rules: [withoutReason] });
    expect(parsed.rules[0].reason).toContain("dealer-config");
  });

  it("reports and skips a rule missing required fields", () => {
    const parsed = parseReviewRules({
      extends: "none",
      rules: [{ id: "no-pattern", stage: VALID.stage }, VALID],
    });
    expect(parsed.rules.map((r) => r.id)).toEqual(["dealer-config"]);
    expect(parsed.problems.join(" ")).toContain("pathPattern");
  });

  it("carries exceptPattern through", () => {
    const parsed = parseReviewRules({
      rules: [{ ...VALID, exceptPattern: "/tests?/" }],
    });
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules[0].exceptPattern).toBe("/tests?/");
  });

  it("drops a malformed exceptPattern but keeps the rule", () => {
    // Ignoring a broken exclusion fails towards more verification; dropping the
    // whole rule would silently remove a review requirement.
    const parsed = parseReviewRules({
      rules: [{ ...VALID, exceptPattern: "([unclosed" }],
    });
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].exceptPattern).toBeUndefined();
    expect(parsed.problems.join(" ")).toContain("exceptPattern");
  });

  it("omits exceptPattern entirely when absent", () => {
    const parsed = parseReviewRules({ rules: [VALID] });
    expect("exceptPattern" in parsed.rules[0]).toBe(false);
  });

  it("rejects an invalid regular expression with the reason", () => {
    const parsed = parseReviewRules({
      extends: "none",
      rules: [{ ...VALID, pathPattern: "([unclosed" }],
    });
    expect(parsed.rules).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("not a valid regular expression");
  });

  it("refuses stage kinds a rule has no business adding", () => {
    // A rule adds verification; it must not inject implementation work or a
    // second terminal gate, both of which belong to the route.
    for (const kind of ["implementation", "humanVerification", "nonsense"]) {
      const parsed = parseReviewRules({
        extends: "none",
        rules: [{ ...VALID, stage: { ...VALID.stage, kind } }],
      });
      expect(parsed.rules, kind).toEqual([]);
      expect(parsed.problems.join(" ")).toContain("kind");
    }
  });

  it("allows the review kinds a rule may add", () => {
    for (const kind of ["test", "codeReview", "domainReview", "behaviourReview"]) {
      const parsed = parseReviewRules({
        extends: "none",
        rules: [{ ...VALID, stage: { ...VALID.stage, kind } }],
      });
      expect(parsed.rules, kind).toHaveLength(1);
    }
  });

  it("rejects an unrecognised gate", () => {
    const parsed = parseReviewRules({
      extends: "none",
      rules: [{ ...VALID, stage: { ...VALID.stage, gate: "sometimes" } }],
    });
    expect(parsed.rules).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("gate");
  });

  it("ignores duplicate rule ids and duplicate stage ids", () => {
    const parsed = parseReviewRules({
      extends: "none",
      rules: [
        VALID,
        VALID,
        { ...VALID, id: "other", stage: { ...VALID.stage } },
      ],
    });
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.problems.join(" ")).toContain("duplicate");
  });

  it("warns about an unknown extends value but keeps the rules", () => {
    const parsed = parseReviewRules({ extends: "everything", rules: [VALID] });
    expect(parsed.rules.map((r) => r.id)).toEqual(["dealer-config"]);
    expect(parsed.problems.join(" ")).toContain("extends");
  });

  it("reports a wholly wrong shape and returns no rules", () => {
    // There is nothing to fall back to, so the honest answer is "none" plus a
    // loud problem. The loader turns this into a visible warning.
    const parsed = parseReviewRules("just a string");
    expect(parsed.rules).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
  });

  it("treats a file with no rules as no rules", () => {
    expect(parseReviewRules({}).rules).toEqual([]);
    expect(parseReviewRules({ rules: [] }).rules).toEqual([]);
  });

  it("reports a non-array rules field", () => {
    const parsed = parseReviewRules({ rules: { id: "x" } });
    expect(parsed.problems.join(" ")).toContain("must be an array");
  });
});

describe("mergeRules", () => {
  const base: ReviewRule[] = [
    { id: "a", reason: "a", pathPattern: "a", stage: { id: "sa", label: "A", kind: "domainReview", intent: "a" } },
    { id: "b", reason: "b", pathPattern: "b", stage: { id: "sb", label: "B", kind: "domainReview", intent: "b" } },
  ];

  it("replaces in place and appends the rest, keeping order stable", () => {
    const merged = mergeRules(base, [
      { id: "b", reason: "b2", pathPattern: "b2", stage: { id: "sb2", label: "B2", kind: "domainReview", intent: "b2" } },
      { id: "c", reason: "c", pathPattern: "c", stage: { id: "sc", label: "C", kind: "domainReview", intent: "c" } },
    ]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(merged[1].pathPattern).toBe("b2");
  });

  it("drops a new rule that would collide on stage id", () => {
    // Pipeline stage ids must be unique, so a collision cannot be allowed
    // through to applyRules.
    const merged = mergeRules(base, [
      { id: "new", reason: "n", pathPattern: "n", stage: { id: "sa", label: "N", kind: "domainReview", intent: "n" } },
    ]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("shipped templates round-trip through the parser", () => {
  it("every template renders to a file that parses with no problems", () => {
    for (const template of RULE_TEMPLATES) {
      const rendered = renderRuleTemplate(template);
      // Comments are stripped by the loader; strip them the same way here.
      const parsed = parseHarnessConfig(JSON.parse(stripJsonComments(rendered)));
      expect(parsed.problems, template.id).toEqual([]);
      expect(parsed.rules.map((r) => r.id), template.id).toEqual(
        template.rules.map((r) => r.id),
      );
    }
  });

  it("seeds the built-in routes so the first edit changes a real workflow", () => {
    const rendered = renderRuleTemplate(RULE_TEMPLATES[0]);
    const parsed = parseHarnessConfig(JSON.parse(stripJsonComments(rendered)));
    expect(parsed.routes.map((r) => r.id)).toEqual(BUILT_IN_ROUTES.map((r) => r.id));
  });

  it("annotates the rendered file, since the reason for a rule is the point", () => {
    const rendered = renderRuleTemplate(RULE_TEMPLATES[0]);
    expect(rendered).toContain("// Harness config for this project");
    expect(rendered).toContain("repository root");
    expect(rendered).toContain('"gate": "approval"');
  });
});

describe("rule stage sendBackTo", () => {
  const rule = (sendBackTo: unknown) => ({
    rules: [
      {
        id: "sql",
        pathPattern: "\.sql$",
        stage: {
          id: "sql-review",
          label: "SQL review",
          kind: "domainReview",
          intent: "Review the objects.",
          sendBackTo,
        },
      },
    ],
  });

  it("accepts a kind entry, which is the only form a rule can use portably", () => {
    const parsed = parseReviewRules(rule(["kind:implementation"]));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules[0].stage.sendBackTo).toEqual(["kind:implementation"]);
  });

  it("rejects a misspelled kind", () => {
    const parsed = parseReviewRules(rule(["kind:implementaton"]));
    expect(parsed.rules).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("not a stage kind");
  });

  it("accepts a bare id, which only resolves in routes that have it", () => {
    // Not an error: a project with one route may legitimately name its stages.
    const parsed = parseReviewRules(rule(["build"]));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules[0].stage.sendBackTo).toEqual(["build"]);
  });

  it("rejects a value that is not an array of strings", () => {
    const parsed = parseReviewRules(rule([{ id: "build" }]));
    expect(parsed.rules).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("array of stage ids");
  });
});
