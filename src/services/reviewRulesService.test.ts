import { describe, it, expect } from "vitest";
import {
  HARNESS_CONFIG_RELATIVE_PATH,
  ReviewRulesReader,
  loadHarness,
  loadReviewRules,
  stripJsonComments,
} from "./reviewRulesService";
import { BUILT_IN_ROUTES } from "../domain/taskRoute";
import { REVIEW_RULES_RELATIVE_PATH } from "../domain/reviewRulesFile";

const ROOT = "C:/repos/app";

/** Reader over an in-memory file map, keyed by forward-slashed path. */
function reader(files: Record<string, string>): ReviewRulesReader {
  return {
    readFile(filePath) {
      return files[filePath.replace(/\\/g, "/")];
    },
  };
}

const PROJECT_RULES = JSON.stringify({
  extends: "none",
  rules: [
    {
      id: "dealer-config",
      reason: "Dealer configuration changed.",
      pathPattern: "dealer",
      stage: {
        id: "dealer-config-review",
        label: "Dealer config review",
        kind: "domainReview",
        intent: "Check dealer overrides.",
      },
    },
  ],
});

describe("loadHarness", () => {
  const HARNESS = `${ROOT}/${HARNESS_CONFIG_RELATIVE_PATH}`;
  const LEGACY = `${ROOT}/${REVIEW_RULES_RELATIVE_PATH}`;

  const PROJECT_ROUTE = {
    id: "dotnet-fix",
    label: ".NET fix",
    stages: [
      { id: "build", label: "Build", kind: "implementation", intent: "Build it." },
      {
        id: "sign-off",
        label: "Sign off",
        kind: "humanVerification",
        intent: "Verify.",
        gate: "approval",
      },
    ],
  };

  it("offers the built-in routes when a project defines none", () => {
    // Routes are process scaffolding, so a usable default beats an empty picker.
    const loaded = loadHarness(ROOT, { reader: reader({}) });
    expect(loaded.usingBuiltInRoutes).toBe(true);
    expect(loaded.routes.map((r) => r.id)).toEqual(BUILT_IN_ROUTES.map((r) => r.id));
    // Rules get no such fallback.
    expect(loaded.rules).toEqual([]);
    expect(loaded.noRulesConfigured).toBe(true);
  });

  it("replaces the built-ins entirely when the project defines routes", () => {
    const loaded = loadHarness(ROOT, {
      reader: reader({
        [HARNESS]: JSON.stringify({ routes: [PROJECT_ROUTE], rules: [] }),
      }),
    });
    expect(loaded.usingBuiltInRoutes).toBe(false);
    expect(loaded.routes.map((r) => r.id)).toEqual(["dotnet-fix"]);
  });

  it("prefers harness.json over the older review-rules.json", () => {
    const loaded = loadHarness(ROOT, {
      reader: reader({
        [HARNESS]: JSON.stringify({ routes: [PROJECT_ROUTE] }),
        [LEGACY]: PROJECT_RULES,
      }),
    });
    expect(loaded.sourcePath?.replace(/\\/g, "/")).toBe(HARNESS);
    expect(loaded.routes.map((r) => r.id)).toEqual(["dotnet-fix"]);
  });

  it("still reads a rules-only review-rules.json, keeping the built-in routes", () => {
    const loaded = loadHarness(ROOT, { reader: reader({ [LEGACY]: PROJECT_RULES }) });
    expect(loaded.rules.map((r) => r.id)).toEqual(["dealer-config"]);
    expect(loaded.usingBuiltInRoutes).toBe(true);
  });

  it("keeps the built-in routes when the config is unparseable", () => {
    // Losing the ability to create any harnessed task because of a typo would be
    // worse than proceeding with defaults and complaining.
    const loaded = loadHarness(ROOT, { reader: reader({ [HARNESS]: "{ oops" }) });
    expect(loaded.usingBuiltInRoutes).toBe(true);
    expect(loaded.rules).toEqual([]);
    expect(loaded.problems.join(" ")).toContain("not valid JSON");
  });

  it("surfaces route validation problems", () => {
    const loaded = loadHarness(ROOT, {
      reader: reader({
        [HARNESS]: JSON.stringify({
          routes: [{ ...PROJECT_ROUTE, stages: [PROJECT_ROUTE.stages[0]] }],
        }),
      }),
    });
    expect(loaded.problems.join(" ")).toContain('"gate": "approval"');
    // The bad route is dropped, so the built-ins stand in.
    expect(loaded.usingBuiltInRoutes).toBe(true);
  });

  it("honours a configured path instead of searching", () => {
    const loaded = loadHarness(ROOT, {
      configuredPath: "build/harness.json",
      reader: reader({
        [`${ROOT}/build/harness.json`]: JSON.stringify({ routes: [PROJECT_ROUTE] }),
      }),
    });
    expect(loaded.routes.map((r) => r.id)).toEqual(["dotnet-fix"]);
  });
});

describe("loadReviewRules", () => {
  it("falls back to the built-ins when a project has no rules file", () => {
    const loaded = loadReviewRules(ROOT, { reader: reader({}) });
    // No rules file means no required reviews — the extension contributes none
    // of its own, so nothing is inherited from another project.
    expect(loaded.noRulesConfigured).toBe(true);
    expect(loaded.rules).toEqual([]);
    expect(loaded.sourcePath).toBeUndefined();
    expect(loaded.problems).toEqual([]);
  });

  it("reads the conventional path inside the repository", () => {
    const loaded = loadReviewRules(ROOT, {
      reader: reader({ [`${ROOT}/${REVIEW_RULES_RELATIVE_PATH}`]: PROJECT_RULES }),
    });
    expect(loaded.noRulesConfigured).toBe(false);
    expect(loaded.rules.map((r) => r.id)).toEqual(["dealer-config"]);
    expect(loaded.sourcePath?.replace(/\\/g, "/")).toBe(
      `${ROOT}/${REVIEW_RULES_RELATIVE_PATH}`,
    );
  });

  it("honours a repository-relative configured path", () => {
    const loaded = loadReviewRules(ROOT, {
      configuredPath: "build/rules.json",
      reader: reader({ [`${ROOT}/build/rules.json`]: PROJECT_RULES }),
    });
    expect(loaded.rules.map((r) => r.id)).toEqual(["dealer-config"]);
  });

  it("honours an absolute path so repositories can share one rule set", () => {
    const shared = "C:/shared/review-rules.json";
    const loaded = loadReviewRules(ROOT, {
      configuredPath: shared,
      reader: reader({ [shared]: PROJECT_RULES }),
    });
    expect(loaded.rules.map((r) => r.id)).toEqual(["dealer-config"]);
    expect(loaded.sourcePath?.replace(/\\/g, "/")).toBe(shared);
  });

  it("treats a whitespace-only configured path as unset", () => {
    const loaded = loadReviewRules(ROOT, {
      configuredPath: "   ",
      reader: reader({ [`${ROOT}/${REVIEW_RULES_RELATIVE_PATH}`]: PROJECT_RULES }),
    });
    expect(loaded.rules.map((r) => r.id)).toEqual(["dealer-config"]);
  });

  it("complains loudly when the file is unparseable, applying no rules", () => {
    // There is nothing to fall back to. The project has rules it cannot read, so
    // the problem must be impossible to miss — otherwise "no reviews required"
    // reads as a clean bill of health for a project expecting the opposite.
    const loaded = loadReviewRules(ROOT, {
      reader: reader({ [`${ROOT}/${REVIEW_RULES_RELATIVE_PATH}`]: "{ oops" }),
    });
    expect(loaded.noRulesConfigured).toBe(true);
    expect(loaded.rules).toEqual([]);
    expect(loaded.problems.join(" ")).toContain("not valid JSON");
    expect(loaded.problems.join(" ")).toContain("No review rules are being applied");
    // The path is still reported so the user knows which file to fix.
    expect(loaded.sourcePath).toBeDefined();
  });

  it("surfaces validation problems from a readable but flawed file", () => {
    const loaded = loadReviewRules(ROOT, {
      reader: reader({
        [`${ROOT}/${REVIEW_RULES_RELATIVE_PATH}`]: JSON.stringify({
          extends: "none",
          rules: [{ id: "broken" }],
        }),
      }),
    });
    expect(loaded.problems.join(" ")).toContain("pathPattern");
    expect(loaded.rules).toEqual([]);
  });

  it("accepts a commented rules file", () => {
    const commented = `{
      // Our team's rules.
      "extends": "none",
      "rules": [
        {
          "id": "dealer-config",
          "reason": "Dealer configuration changed.",
          /* Matches anything dealer-shaped. */
          "pathPattern": "dealer",
          "stage": {
            "id": "dealer-config-review",
            "label": "Dealer config review",
            "kind": "domainReview",
            "intent": "Check dealer overrides."
          }
        }
      ]
    }`;
    const loaded = loadReviewRules(ROOT, {
      reader: reader({ [`${ROOT}/${REVIEW_RULES_RELATIVE_PATH}`]: commented }),
    });
    expect(loaded.problems).toEqual([]);
    expect(loaded.rules.map((r) => r.id)).toEqual(["dealer-config"]);
  });
});

describe("stripJsonComments", () => {
  it("removes line and block comments", () => {
    expect(stripJsonComments('{"a":1} // trailing').trim()).toBe('{"a":1}');
    expect(stripJsonComments('{/* mid */"a":1}')).toBe('{"a":1}');
  });

  it("preserves slashes and stars inside strings", () => {
    // Rule patterns are full of slashes; mangling them would silently change
    // which files a rule matches.
    const input = '{"pathPattern":"/api/|https://x","b":"/* not a comment */"}';
    expect(stripJsonComments(input)).toBe(input);
  });

  it("preserves an escaped quote before a comment", () => {
    const input = '{"a":"say \\"hi\\""} // done';
    expect(stripJsonComments(input).trim()).toBe('{"a":"say \\"hi\\""}');
  });

  it("keeps newlines so error line numbers stay meaningful", () => {
    expect(stripJsonComments("{\n// c\n}")).toBe("{\n\n}");
  });
});
