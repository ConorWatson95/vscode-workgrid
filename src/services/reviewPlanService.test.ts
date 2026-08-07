import { describe, it, expect } from "vitest";
import {
  ChangedPathsSource,
  ReviewPlanService,
  RuleAdditionRequest,
  formatReviewPlan,
} from "./reviewPlanService";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Logger } from "../logging/logger";
import { LoadedReviewRules } from "./reviewRulesService";
import { findRuleTemplate } from "../domain/reviewRuleTemplates";
import { createPipeline } from "../domain/pipelineEngine";
import { findRoute } from "../domain/taskRoute";
import { ok, err } from "../utilities/result";
import { GitError } from "../git/gitClient";

const warnings: string[] = [];
const logger: Logger = {
  info: () => {},
  warn: (m) => warnings.push(m),
  error: () => {},
  debug: () => {},
};

function paths(...list: string[]): ChangedPathsSource {
  return { getChangedPaths: async () => ok(list) };
}

const failing: ChangedPathsSource = {
  getChangedPaths: async () =>
    err({ kind: "spawn", message: "git not found" } as unknown as GitError),
};

/**
 * Stands in for a project that has configured the .NET template. The extension
 * ships no rules, so a test must state which rule set the project uses.
 */
function projectRules(): LoadedReviewRules {
  return {
    rules: [...findRuleTemplate("dotnet")!.rules],
    problems: [],
    noRulesConfigured: false,
    sourcePath: "C:/repos/app/.taskworkspaces/review-rules.json",
  };
}

/** Stands in for a project with no rules file at all. */
function noRules(): LoadedReviewRules {
  return { rules: [], problems: [], noRulesConfigured: true };
}

function task(overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id: "t1",
    name: "Fix dealer mapping",
    repositoryRoot: "C:/repos/app",
    worktreePath: "C:/repos/app-t1",
    branchName: "bug/dealer-mapping",
    baseBranch: "main",
    status: "ready",
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

function service(
  source: ChangedPathsSource,
  rules = projectRules(),
  confirm?: (request: RuleAdditionRequest) => Promise<boolean>,
) {
  const repo = new InMemoryTaskRepository();
  return {
    repo,
    plans: new ReviewPlanService(source, repo, logger, () => rules, confirm),
  };
}

/** A harnessed task partway through the bug-fix route. */
function harnessed(): TaskWorkspace {
  return task({ pipeline: createPipeline(findRoute("bug-fix")!) });
}

describe("plan", () => {
  it("reports the reviews a real diff obliges", async () => {
    const { plans } = service(paths("src/Mapping/CustomerProfile.cs"));
    const result = await plans.plan(task());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.required.map((r) => r.stageId)).toEqual([
      "mapping-behaviour-review",
    ]);
    expect(result.value.required[0].triggeredBy).toEqual([
      "src/Mapping/CustomerProfile.cs",
    ]);
  });

  it("explains each requirement with the rule author's reason", async () => {
    const { plans } = service(paths("db/migrations/001.sql"));
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(result.value.required[0].reason).toContain("SQL");
  });

  it("returns nothing to do for an unremarkable diff", async () => {
    const { plans } = service(paths("README.md"));
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(result.value.required).toEqual([]);
  });

  it("handles a task with no changes at all", async () => {
    const { plans } = service(paths());
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(result.value.changedPaths).toEqual([]);
    expect(result.value.required).toEqual([]);
  });

  it("marks a task with no pipeline as unharnessed, so results are advisory", async () => {
    const { plans } = service(paths("a.sql"));
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(result.value.harnessed).toBe(false);
    expect(result.value.required[0].alreadyOnPipeline).toBe(false);
  });

  it("distinguishes reviews already on a harnessed pipeline", async () => {
    const { repo, plans } = service(paths("a.sql"));
    await repo.save(harnessed());

    // The route's own stages do not include a SQL review, so it starts missing.
    const before = await plans.plan((await repo.get("t1"))!);
    if (!before.ok) return;
    expect(before.value.harnessed).toBe(true);
    expect(before.value.required[0].alreadyOnPipeline).toBe(false);

    await plans.apply((await repo.get("t1"))!);

    // Once appended, the same diff reports it as satisfied rather than missing.
    const after = await plans.plan((await repo.get("t1"))!);
    if (!after.ok) return;
    expect(after.value.required[0].alreadyOnPipeline).toBe(true);
  });

  it("propagates a git failure rather than reporting no reviews", async () => {
    // Silently claiming "no reviews required" when git failed would be the
    // dangerous outcome.
    const { plans } = service(failing);
    const result = await plans.plan(task());
    expect(result.ok).toBe(false);
  });

  it("logs problems from a project's rules file", async () => {
    warnings.length = 0;
    const { plans } = service(paths("a.sql"), {
      ...projectRules(),
      problems: ['Rule "x": "pathPattern" is required.'],
    });
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(result.value.problems).toHaveLength(1);
    expect(warnings.join(" ")).toContain("pathPattern");
  });

  it("uses the project's rules rather than the built-ins when supplied", async () => {
    const { plans } = service(paths("src/Dealers/Overrides.json"), {
      rules: [
        {
          id: "dealer",
          reason: "Dealer overrides changed.",
          pathPattern: "dealers?/",
          stage: {
            id: "dealer-review",
            label: "Dealer review",
            kind: "domainReview",
            intent: "Check overrides.",
          },
        },
      ],
      problems: [],
      noRulesConfigured: false,
      sourcePath: "C:/repos/app/.taskworkspaces/review-rules.json",
    });
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(result.value.required.map((r) => r.stageId)).toEqual(["dealer-review"]);
  });
});

describe("apply", () => {
  it("splices missing review stages straight after the work and persists them", async () => {
    const { repo, plans } = service(paths("db/migrations/001.sql"));
    const original = harnessed();
    await repo.save(original);

    const result = await plans.apply(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.added.map((s) => s.id)).toEqual(["sql-review"]);

    const saved = await repo.get("t1");
    const ids = saved?.pipeline?.stages.map((s) => s.id) ?? [];
    // Directly after "fix", not just before the gate. Anything between the work and
    // the review of it is discarded and re-run when the review sends work back.
    expect(ids).toEqual([
      "reproduce",
      "fix",
      "sql-review",
      "regression-test",
      "code-review",
      "human-verification",
    ]);
  });

  it("records why each stage was added", async () => {
    const { repo, plans } = service(paths("db/migrations/001.sql"));
    const original = harnessed();
    await repo.save(original);
    await plans.apply(original);
    const saved = await repo.get("t1");
    const stage = saved?.pipeline?.stages.find((s) => s.id === "sql-review");
    expect(stage?.addedByRule).toContain("SQL");
  });

  it("is idempotent, so re-running never duplicates a stage", async () => {
    const { repo, plans } = service(paths("db/migrations/001.sql"));
    await repo.save(harnessed());
    const first = await plans.apply((await repo.get("t1"))!);
    if (!first.ok) return;
    expect(first.value.added).toHaveLength(1);

    const second = await plans.apply((await repo.get("t1"))!);
    if (!second.ok) return;
    expect(second.value.added).toEqual([]);
    const stages = (await repo.get("t1"))?.pipeline?.stages ?? [];
    expect(stages.filter((s) => s.id === "sql-review")).toHaveLength(1);
  });

  it("leaves an unharnessed task untouched rather than inventing a route", async () => {
    const { repo, plans } = service(paths("db/migrations/001.sql"));
    const unharnessed = task();
    await repo.save(unharnessed);
    const result = await plans.apply(unharnessed);
    if (!result.ok) return;
    expect(result.value.added).toEqual([]);
    expect((await repo.get("t1"))?.pipeline).toBeUndefined();
  });

  it("does not write when nothing needs adding", async () => {
    const { repo, plans } = service(paths("README.md"));
    const original = harnessed();
    await repo.save(original);
    const before = (await repo.get("t1"))!.updatedAt;
    await plans.apply(original);
    expect((await repo.get("t1"))!.updatedAt).toBe(before);
  });
});

describe("formatReviewPlan", () => {
  it("names the rules source and justifies each requirement", async () => {
    const { plans } = service(paths("db/migrations/001.sql"));
    const result = await plans.plan(harnessed());
    if (!result.ok) return;
    const text = formatReviewPlan(harnessed(), result.value);
    expect(text).toContain("SQL review");
    expect(text).toContain("db/migrations/001.sql");
    expect(text).toContain("review-rules.json");
    expect(text).toContain("[missing]");
  });

  it("tells a project with no rules how to add some", async () => {
    const { plans } = service(paths("a.sql"), noRules());
    const result = await plans.plan(task());
    if (!result.ok) return;
    const text = formatReviewPlan(task(), result.value);
    expect(text).toContain("no review rules");
    expect(text).toContain("Create Review Rules File");
  });

  it("says so plainly when a task has no route", async () => {
    const { plans } = service(paths("a.sql"));
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(formatReviewPlan(task(), result.value)).toContain("advisory only");
  });

  it("truncates a long trigger list rather than flooding the log", async () => {
    const many = Array.from({ length: 9 }, (_, i) => `db/m${i}.sql`);
    const { plans } = service(paths(...many));
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(formatReviewPlan(task(), result.value)).toContain("and 4 more");
  });

  it("reports a clean result", async () => {
    const { plans } = service(paths("README.md"));
    const result = await plans.plan(task());
    if (!result.ok) return;
    expect(formatReviewPlan(task(), result.value)).toContain("No rules matched");
  });
});

describe("confirming several rule-added reviews", () => {
  /** Enough matching paths to trigger three or more of the .NET template's rules. */
  const MANY = {
    getChangedPaths: async () =>
      ok([
        "src/Api/Mapping/DealerProfile.cs",
        "src/Api/Controllers/ExportController.cs",
        "db/migrations/003-add-column.sql",
        "src/Api/Resources/Text.resx",
        "tools/ci/build.ps1",
      ]),
  } as ChangedPathsSource;

  it("asks before adding more than a couple, with the evidence", async () => {
    let request: RuleAdditionRequest | undefined;
    const { plans, repo } = service(MANY, projectRules(), async (r) => {
      request = r;
      return true;
    });
    const subject = harnessed();
    await repo.save(subject);

    const result = await plans.apply(subject);
    expect(result.ok).toBe(true);
    expect(request).toBeDefined();
    // The number that explains a surprising set of reviews.
    expect(request?.changedPathCount).toBe(5);
    expect(request!.added.length).toBeGreaterThan(2);
  });

  it("adds nothing when declined, leaving the pipeline as it was", async () => {
    const { plans, repo } = service(MANY, projectRules(), async () => false);
    const subject = harnessed();
    await repo.save(subject);
    const before = subject.pipeline!.stages.length;

    const result = await plans.apply(subject);
    expect(result.ok && result.value.added).toEqual([]);
    expect(result.ok && result.value.declined?.length).toBeGreaterThan(0);
    const saved = await repo.get(subject.id);
    expect(saved?.pipeline?.stages).toHaveLength(before);
  });

  it("asks once per set, not once per advance", async () => {
    // The driver loops; without this it would ask on every iteration.
    let asked = 0;
    const { plans, repo } = service(MANY, projectRules(), async () => {
      asked += 1;
      return false;
    });
    const subject = harnessed();
    await repo.save(subject);

    await plans.apply(subject);
    await plans.apply(subject);
    await plans.apply(subject);
    expect(asked).toBe(1);
  });

  it("applies them without asking when there is nobody to ask", async () => {
    // Headless: no confirmation hook, so behaviour is exactly as before.
    const { plans, repo } = service(MANY);
    const subject = harnessed();
    await repo.save(subject);

    const result = await plans.apply(subject);
    expect(result.ok && result.value.added.length).toBeGreaterThan(2);
  });

  it("does not ask for one or two, which is the design working", async () => {
    let asked = 0;
    const oneFile = {
      getChangedPaths: async () => ok(["src/Api/Mapping/DealerProfile.cs"]),
    } as ChangedPathsSource;
    const { plans, repo } = service(oneFile, projectRules(), async () => {
      asked += 1;
      return true;
    });
    const subject = harnessed();
    await repo.save(subject);

    const result = await plans.apply(subject);
    expect(asked).toBe(0);
    expect(result.ok && result.value.added.length).toBeGreaterThan(0);
  });
});
