import { describe, expect, it } from "vitest";
import { compareRuns, formatRunComparison, percentChange } from "./runComparison";
import { TaskPipeline, TaskStage, Subtask } from "./taskPipeline";

const subtask = (over: Partial<Subtask> = {}): Subtask =>
  ({
    id: "s1",
    title: "Do it",
    prompt: "p",
    status: "done",
    startedAt: "2026-08-07T10:00:00.000Z",
    finishedAt: "2026-08-07T10:05:00.000Z",
    activity: {
      costUsd: 1,
      tokens: { input: 1000, output: 500, cacheRead: 4000, cacheCreation: 0 },
      actualModel: "claude-opus-5",
    },
    ...over,
  }) as Subtask;

const stage = (id: string, over: Partial<TaskStage> = {}): TaskStage =>
  ({
    id,
    name: id,
    kind: "implementation",
    status: "passed",
    intent: "",
    splittable: false,
    requiresApproval: false,
    subtasks: [subtask()],
    ...over,
  }) as TaskStage;

const run = (over: Partial<TaskPipeline> = {}): TaskPipeline =>
  ({
    routeId: "sql-change",
    stages: [stage("implement"), stage("review")],
    ...over,
  }) as TaskPipeline;

const control = () =>
  run({ experiment: { id: "handoffs", arm: "control", at: "t" } });
const treatment = () =>
  run({ experiment: { id: "handoffs", arm: "no-handoffs", at: "t" } });

describe("percentChange", () => {
  it("has no answer without a baseline", () => {
    // Rendered as a dash rather than as 0% or Infinity: "no change" and "nothing to
    // compare against" are opposite readings of the same cell.
    expect(percentChange(0, 5)).toBeUndefined();
  });

  it("is negative when the second run spent less", () => {
    expect(percentChange(10, 8)).toBeCloseTo(-20);
  });
});

describe("compareRuns", () => {
  it("totals each run and pairs the stages by id", () => {
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: treatment() },
    );
    expect(comparison.a.totals.costUsd).toBe(2);
    expect(comparison.stages.map((s) => s.stageId)).toEqual(["implement", "review"]);
    expect(comparison.stages[0].a).toBeDefined();
    expect(comparison.stages[0].b).toBeDefined();
  });

  it("warns when both runs are on the same arm", () => {
    // The mistake that produces a number meaning nothing: this measures the
    // difference between two pieces of work, and reads exactly like a result.
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: control() },
    );
    expect(comparison.warnings.join(" ")).toMatch(/Both runs are on the `control` arm/);
  });

  it("warns when either run records no arm at all", () => {
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: run() },
    );
    expect(comparison.warnings.join(" ")).toMatch(/records no experiment arm/);
  });

  it("warns when the routes differ", () => {
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: run({ routeId: "app-change", experiment: treatment().experiment }) },
    );
    expect(comparison.warnings.join(" ")).toMatch(/different routes/);
  });

  it("warns when a different model actually ran", () => {
    // The trap actualModel was recorded to catch: a policy substitutes a model
    // without failing, so the cost difference is the model rather than the change.
    const cheap = treatment();
    cheap.stages[0].subtasks[0].activity!.actualModel = "claude-haiku-4-5";
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: cheap },
    );
    expect(comparison.warnings.join(" ")).toMatch(/Different models actually ran/);
  });

  it("warns when subtasks reported no usage, so a total is partial", () => {
    const partial = treatment();
    partial.stages[1].subtasks = [subtask({ activity: { toolCounts: {} } })];
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: partial },
    );
    expect(comparison.warnings.join(" ")).toMatch(/reported no usage/);
  });

  it("warns about a stage that exists in only one run", () => {
    const extra = treatment();
    extra.stages = [...extra.stages, stage("sql-review", { kind: "domainReview" })];
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: extra },
    );
    expect(comparison.warnings.join(" ")).toMatch(/exist in only one run/);
    expect(comparison.stages.map((s) => s.stageId)).toContain("sql-review");
  });

  it("warns when one run proved less than the other", () => {
    // A run that is cheaper because less of it was checked is not cheaper, and that
    // is invisible in a table of costs.
    const checked = treatment();
    checked.stages[0].verification = { command: "npm test", exitCode: 0, at: "t" };
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: checked },
    );
    expect(comparison.warnings.join(" ")).toMatch(/differ in how much they proved/);
  });

  it("says nothing when two runs on opposite arms are otherwise alike", () => {
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: treatment() },
    );
    expect(comparison.warnings).toEqual([]);
  });

  it("counts interventions, which is the number the harness is judged on", () => {
    const supervised = treatment();
    supervised.interventions = [
      { kind: "approval", at: "t", stageId: "implement" },
      { kind: "answeredQuestion", at: "t" },
    ] as TaskPipeline["interventions"];
    const comparison = compareRuns(
      { label: "A", pipeline: control() },
      { label: "B", pipeline: supervised },
    );
    expect(comparison.a.interventions).toBe(0);
    expect(comparison.b.interventions).toBe(2);
  });
});

describe("formatRunComparison", () => {
  it("puts the caveats above the totals", () => {
    // A comparison is read for its bottom line, so a caveat printed under one is a
    // caveat nobody applied.
    const markdown = formatRunComparison(
      compareRuns({ label: "A", pipeline: control() }, { label: "B", pipeline: control() }),
    );
    expect(markdown.indexOf("Read these first")).toBeLessThan(markdown.indexOf("## Totals"));
  });

  it("omits the caveat section entirely when there is nothing to say", () => {
    const markdown = formatRunComparison(
      compareRuns({ label: "A", pipeline: control() }, { label: "B", pipeline: treatment() }),
    );
    expect(markdown).not.toMatch(/Read these first/);
  });

  it("names each run's arm in the header", () => {
    const markdown = formatRunComparison(
      compareRuns({ label: "Run one", pipeline: control() }, { label: "Run two", pipeline: treatment() }),
    );
    expect(markdown).toMatch(/\*\*A:\*\* Run one · arm `control`/);
    expect(markdown).toMatch(/\*\*B:\*\* Run two · arm `no-handoffs`/);
  });

  it("shows fresh input separately from cached, which is the number at issue", () => {
    // A stage that rediscovers reads files again, and that lands in fresh input
    // rather than in cache reads — collapsing them to a total hides the effect.
    const markdown = formatRunComparison(
      compareRuns({ label: "A", pipeline: control() }, { label: "B", pipeline: treatment() }),
    );
    expect(markdown).toMatch(/Fresh input tokens/);
    expect(markdown).toMatch(/Cached input/);
  });
});
