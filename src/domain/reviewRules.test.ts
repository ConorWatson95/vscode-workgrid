import { describe, it, expect } from "vitest";
import {
  BEHAVIOUR_REVIEW_BRIEF,
  NO_REVIEW_RULES,
  evaluateRules,
  ruleStageDefinition,
} from "./reviewRules";
import { producesChecklist } from "./taskRoute";
import { RULE_TEMPLATES, findRuleTemplate } from "./reviewRuleTemplates";

/**
 * The .NET template is the rule set these path-matching cases exercise. It is a
 * template a project copies, not something the extension applies — so it is
 * named explicitly here rather than relied on as a default.
 */
const DOTNET = findRuleTemplate("dotnet")!.rules;

/** Which rule ids fire for a given set of changed paths. */
function firedFor(...paths: string[]): string[] {
  return evaluateRules(paths, DOTNET).map((m) => m.rule.id);
}

describe("the extension's own rule set", () => {
  it("is empty, so no project inherits another team's assumptions", () => {
    expect(NO_REVIEW_RULES).toEqual([]);
  });

  it("is what evaluateRules falls back to, requiring nothing", () => {
    // A project with no rules file must get "no reviews required", not somebody
    // else's decision table.
    expect(evaluateRules(["src/Mapping/CustomerProfile.cs", "a.sql"])).toEqual([]);
  });
});

describe("evaluateRules", () => {
  it("matches nothing for an unremarkable change", () => {
    expect(firedFor("README.md", "src/utilities/branchName.ts")).toEqual([]);
  });

  it("requires SQL review for schema and stored procedure changes", () => {
    expect(firedFor("db/migrations/003_add_index.sql")).toContain("sql");
    expect(firedFor("Database/StoredProcedures/GetDealers.sql")).toContain("sql");
  });

  it("requires behaviour review for a mapping profile change", () => {
    // The case from the mapping regression: compiles, tests pass, behaviour moved.
    expect(firedFor("src/Mapping/CustomerProfile.cs")).toContain("mapping-profile");
    expect(firedFor("Api/AutoMapperConfig.cs")).toContain("mapping-profile");
  });

  it("requires compatibility review for API surface changes", () => {
    expect(firedFor("src/Controllers/CustomerController.cs")).toContain("api-contract");
    expect(firedFor("contracts/orders.proto")).toContain("api-contract");
    expect(firedFor("src/Dtos/CustomerDto.cs")).toContain("api-contract");
  });

  it("requires security review for auth changes", () => {
    expect(firedFor("src/Identity/TokenService.cs")).toContain("authentication");
    expect(firedFor("src/Auth/Permissions.cs")).toContain("authentication");
  });

  it("requires result-shape validation for reporting changes", () => {
    expect(firedFor("Reports/DealerSummary.rdl")).toContain("reporting");
    expect(firedFor("src/Export/CsvWriter.cs")).toContain("reporting");
  });

  it("requires a smoke test for user-facing UI changes", () => {
    expect(firedFor("Views/Customer/Edit.cshtml")).toContain("ui");
    expect(firedFor("src/Pages/Dealer.razor")).toContain("ui");
  });

  it("does not fire on an unrelated codebase's files", () => {
    // The .NET template must not match this repository's own TypeScript and CSS.
    // Applying one project's rules to another was a real defect: media/*.css
    // used to demand a UI behaviour review with a human checklist.
    expect(
      firedFor(
        "media/chat.js",
        "media/chat.css",
        "src/ui/agentChatPanel.ts",
        "src/utilities/pathUtilities.ts",
        "docs/authoring-guide.md",
        "src/Services/BugReportSanitiser.cs",
      ),
    ).toEqual([]);
  });

  it("stacks rules when one change touches several concerns", () => {
    const fired = firedFor(
      "src/Mapping/CustomerProfile.cs",
      "db/migrations/004.sql",
      "Reports/Summary.rdl",
    );
    expect(fired).toEqual(expect.arrayContaining(["sql", "mapping-profile", "reporting"]));
  });

  it("yields one match per rule regardless of how many files triggered it", () => {
    const matches = evaluateRules(["a.sql", "b.sql", "c.sql"], DOTNET);
    const sql = matches.filter((m) => m.rule.id === "sql");
    expect(sql).toHaveLength(1);
    expect(sql[0].matchedPaths).toHaveLength(3);
  });

  it("normalises Windows separators so rules are written one way", () => {
    expect(firedFor("Database\\StoredProcedures\\GetDealers.sql")).toContain("sql");
    expect(firedFor("src\\Views\\Edit.cshtml")).toContain("ui");
  });

  it("matches case-insensitively", () => {
    expect(firedFor("DB/MIGRATIONS/001.SQL")).toContain("sql");
  });

  it("matches top-level directories, not just nested ones", () => {
    // A .NET solution commonly has Controllers/ and Mapping/ at the repository
    // root. Requiring a leading slash silently missed all of them.
    expect(firedFor("Mapping/CustomerProfile.cs")).toContain("mapping-profile");
    expect(firedFor("Controllers/DealerController.cs")).toContain("api-contract");
    expect(firedFor("Views/Edit.cshtml")).toContain("ui");
    expect(firedFor("Reports/Summary.cs")).toContain("reporting");
    expect(firedFor("Auth/Permissions.cs")).toContain("authentication");
    expect(firedFor("StoredProcedures/GetDealers.txt")).toContain("sql");
  });

  it("excludes test-only changes from behaviour reviews", () => {
    // This was the last surviving false positive: a test file under Mapping/
    // used to demand a manual behaviour checklist with nothing to click.
    expect(firedFor("tests/Mapping/CustomerProfileTests.cs")).toEqual([]);
    expect(firedFor("src/Reports/Summary.Tests.cs")).toEqual([]);
    expect(firedFor("Views/__tests__/Edit.cshtml")).toEqual([]);
  });

  it("still fires when production code changes alongside its tests", () => {
    // The exclusion filters paths, not rules — one real path is enough.
    expect(
      firedFor(
        "src/Mapping/CustomerProfile.cs",
        "tests/Mapping/CustomerProfileTests.cs",
      ),
    ).toContain("mapping-profile");
  });

  it("reports only the paths that actually triggered a rule", () => {
    const [match] = evaluateRules(
      ["src/Mapping/CustomerProfile.cs", "tests/Mapping/CustomerProfileTests.cs"],
      DOTNET,
    );
    // An excluded path must not appear in the justification shown to the user.
    expect(match.matchedPaths).toEqual(["src/Mapping/CustomerProfile.cs"]);
  });

  it("keeps domain reviews for test-project SQL, which can still matter", () => {
    // Only behaviour-flavoured rules carry the test exclusion.
    expect(firedFor("tests/Database/seed.sql")).toContain("sql");
  });

  it("ignores a malformed exceptPattern rather than dropping the rule", () => {
    // Failing towards more verification is the safe direction.
    const matches = evaluateRules(["a.sql"], [
      {
        id: "sql",
        reason: "sql",
        pathPattern: "\\.sql$",
        exceptPattern: "([unclosed",
        stage: { id: "s", label: "S", kind: "domainReview", intent: "x" },
      },
    ]);
    expect(matches.map((m) => m.rule.id)).toEqual(["sql"]);
  });

  it("skips a rule with an invalid pattern rather than throwing", () => {
    const matches = evaluateRules(["anything"], [
      {
        id: "bad",
        reason: "broken",
        pathPattern: "([unclosed",
        stage: { id: "x", label: "X", kind: "domainReview", intent: "x" },
      },
    ]);
    expect(matches).toEqual([]);
  });

  it("preserves rule-set order so review sequence is predictable", () => {
    const fired = firedFor("x.sql", "Views/Edit.cshtml");
    expect(fired.indexOf("sql")).toBeLessThan(fired.indexOf("ui"));
  });
});

describe("shipped rule templates", () => {
  const everyRule = RULE_TEMPLATES.flatMap((t) => t.rules.map((r) => ({ t, r })));

  it("gives every rule a unique id and stage id within its template", () => {
    for (const template of RULE_TEMPLATES) {
      const ruleIds = template.rules.map((r) => r.id);
      const stageIds = template.rules.map((r) => r.stage.id);
      expect(new Set(ruleIds).size, template.id).toBe(ruleIds.length);
      expect(new Set(stageIds).size, template.id).toBe(stageIds.length);
    }
  });

  it("only produces review stages, never implementation work", () => {
    for (const { t, r } of everyRule) {
      expect(["domainReview", "behaviourReview"], `${t.id}/${r.id}`).toContain(
        r.stage.kind,
      );
    }
  });

  it("never gates a rule-added stage itself", () => {
    // Behaviour reviews raise verification items; the route's terminal
    // human-verification gate is the single place that refuses to advance while
    // items are outstanding. A rule-added stage that gated on its own checklist
    // could never let those items reach the end.
    for (const { t, r } of everyRule) {
      expect(r.stage.gate ?? "auto", `${t.id}/${r.id}`).toBe("auto");
    }
  });

  it("marks the .NET template's behaviour stages as checklist producers", () => {
    const behaviour = DOTNET.filter((r) => producesChecklist(r.stage.kind));
    expect(behaviour.map((r) => r.id)).toEqual([
      "mapping-profile",
      "reporting",
      "ui",
    ]);
  });

  it("frames behaviour reviews as QA planning rather than judgement", () => {
    const behaviour = everyRule.filter(({ r }) => r.stage.kind === "behaviourReview");
    expect(behaviour.length).toBeGreaterThan(0);
    for (const { t, r } of behaviour) {
      expect(r.stage.intent, `${t.id}/${r.id}`).toContain(BEHAVIOUR_REVIEW_BRIEF);
    }
  });

  it("has a compilable pattern for every rule", () => {
    for (const { t, r } of everyRule) {
      expect(() => new RegExp(r.pathPattern, "i"), `${t.id}/${r.id}`).not.toThrow();
    }
  });

  it("stays JSON-serialisable, since templates are written to disk as JSON", () => {
    for (const template of RULE_TEMPLATES) {
      expect(JSON.parse(JSON.stringify(template.rules))).toEqual(template.rules);
    }
  });
});

describe("ruleStageDefinition", () => {
  it("defaults to a single-unit stage behind an auto gate", () => {
    const definition = ruleStageDefinition({
      id: "r",
      reason: "because",
      pathPattern: "x",
      stage: { id: "s", label: "S", kind: "domainReview", intent: "review it" },
    });
    expect(definition).toEqual({
      id: "s",
      label: "S",
      kind: "domainReview",
      intent: "review it",
      workflow: undefined,
      splittable: false,
      gate: "auto",
    });
  });

  it("carries an explicit gate and workflow through", () => {
    const definition = ruleStageDefinition(
      DOTNET.find((r) => r.id === "authentication")!,
    );
    expect(definition.workflow).toBe("/security-review");
  });
});
