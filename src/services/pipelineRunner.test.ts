import { describe, it, expect } from "vitest";
import { PipelineRunner, StageSessionRunner } from "./pipelineRunner";
import { ReviewPlanService, ChangedPathsSource } from "./reviewPlanService";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { createPipeline } from "../domain/pipelineEngine";
import { RouteDefinition } from "../domain/taskRoute";
import { Logger } from "../logging/logger";
import { LoadedReviewRules } from "./reviewRulesService";
import { ok } from "../utilities/result";

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** Two implementation stages plus a gate: enough to exercise every action. */
const ROUTE: RouteDefinition = {
  id: "test",
  label: "Test",
  description: "d",
  stages: [
    {
      id: "build",
      label: "Build",
      kind: "implementation",
      intent: "Build it.",
      splittable: true,
      gate: "auto",
    },
    {
      id: "behaviour",
      label: "Behaviour review",
      kind: "behaviourReview",
      intent: "Say what a human must check.",
      splittable: false,
      gate: "auto",
    },
    {
      id: "human-verification",
      label: "Human verification",
      kind: "humanVerification",
      intent: "Verify by hand.",
      splittable: false,
      gate: "approval",
    },
  ],
};

function task(): TaskWorkspace {
  return {
    id: "t1",
    name: "Fix dealer mapping",
    repositoryRoot: "C:/repos/app",
    worktreePath: "C:/repos/app-t1",
    branchName: "bug/dealer-mapping",
    baseBranch: "main",
    status: "ready",
    createdAt: "t",
    updatedAt: "t",
    pipeline: createPipeline(ROUTE),
  };
}

/** Records prompts and replies with canned text, keyed by label prefix. */
function fakeSessions(
  replies: Record<string, { ok?: boolean; text: string }> = {},
): StageSessionRunner & { calls: { label: string; prompt: string }[] } {
  const calls: { label: string; prompt: string }[] = [];
  return {
    calls,
    async run(_task, prompt, label) {
      calls.push({ label, prompt });
      const key = Object.keys(replies).find((k) => label.startsWith(k));
      const reply = key ? replies[key] : undefined;
      return {
        ok: reply?.ok ?? true,
        text: reply?.text ?? "done",
        error: (reply?.ok ?? true) ? undefined : "agent failed",
      };
    },
  };
}

function makeRunner(
  sessions: StageSessionRunner,
  options: {
    paths?: string[];
    rules?: LoadedReviewRules;
    /** Reuse a repository, e.g. to model a second attempt on the same task. */
    repo?: InMemoryTaskRepository;
  } = {},
) {
  const repo = options.repo ?? new InMemoryTaskRepository();
  const changed: ChangedPathsSource = {
    getChangedPaths: async () => ok(options.paths ?? []),
  };
  const rules: LoadedReviewRules =
    options.rules ?? { rules: [], problems: [], noRulesConfigured: true };
  const plans = new ReviewPlanService(changed, repo, logger, () => rules);
  return { repo, runner: new PipelineRunner(sessions, repo, plans, logger) };
}

const PLAN_REPLY = "1. Part one — do one.\n2. Part two — do two.";

describe("advance", () => {
  it("does nothing for an unharnessed task", async () => {
    const { runner } = makeRunner(fakeSessions());
    const report = await runner.advance({ ...task(), pipeline: undefined });
    expect(report.outcome).toEqual({ kind: "unharnessed" });
  });

  it("splits, runs every subtask, then stops at the human gate", async () => {
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "behaviour:": { text: "- Edit an existing customer" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.outcome).toMatchObject({
      kind: "awaitingApproval",
      stageId: "human-verification",
    });
    // Planning, two subtasks, the behaviour review, and the gate's own unit.
    expect(sessions.calls.map((c) => c.label)).toEqual([
      "plan:build",
      "build:build-1",
      "build:build-2",
      "behaviour:behaviour-1",
      "human-verification:human-verification-1",
    ]);
  });

  it("runs each subtask in its own session call, never one long conversation", async () => {
    const sessions = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const subtaskCalls = sessions.calls.filter((c) => c.label.startsWith("build:"));
    expect(subtaskCalls).toHaveLength(2);
    // Each prompt is self-contained: it names its own objective.
    expect(subtaskCalls[0].prompt).toContain("Part one");
    expect(subtaskCalls[1].prompt).toContain("Part two");
    expect(subtaskCalls[1].prompt).not.toContain("Part one");
  });

  it("persists progress as it goes, so a crash does not lose the route", async () => {
    const sessions = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const saved = await repo.get("t1");
    const build = saved?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.status).toBe("passed");
    expect(build?.subtasks.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("records the behaviour review's checklist against its stage", async () => {
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "behaviour:": { text: "- Edit an existing customer\n- Run a dealer report" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const saved = await repo.get("t1");
    const stage = saved?.pipeline?.stages.find((s) => s.id === "behaviour");
    expect(stage?.checklist?.map((i) => i.text)).toEqual([
      "Edit an existing customer",
      "Run a dealer report",
    ]);
  });

  it("accepts NONE from a behaviour review as a real answer", async () => {
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "behaviour:": { text: "NONE" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    const report = await runner.advance((await repo.get("t1"))!);
    expect(report.outcome).toMatchObject({ kind: "awaitingApproval" });
    expect(report.steps.join(" ")).toContain("nothing needing manual verification");
  });

  it("pauses and reports the question when a stage asks for information", async () => {
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "build:build-1": { text: "NEEDS-INFO: Which dealer fields are in scope?" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);
    expect(report.outcome).toMatchObject({
      kind: "needsInput",
      stageId: "build",
      subtaskId: "build-1",
      question: "Which dealer fields are in scope?",
    });
    // Nothing beyond it was attempted.
    expect(sessions.calls.map((c) => c.label)).not.toContain("build:build-2");
  });

  it("leaves the asking subtask pending so it re-runs once answered", async () => {
    // Recording it as done would be a lie; recording it as failed would block.
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "build:build-1": { text: "NEEDS-INFO: Which fields?" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const stage = (await repo.get("t1"))?.pipeline?.stages.find((s) => s.id === "build");
    expect(stage?.status).toBe("pending");
    expect(stage?.subtasks[0]).toMatchObject({ status: "pending" });
    expect(stage?.subtasks[0].startedAt).toBeUndefined();
  });

  it("resumes from the same subtask on the next attempt", async () => {
    const asking = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "build:build-1": { text: "NEEDS-INFO: Which fields?" },
    });
    const { repo, runner } = makeRunner(asking);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    // A second attempt over the same repository, standing in for "the brief was
    // answered so the stage no longer needs to ask".
    const answered = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { runner: second } = makeRunner(answered, { repo });
    const report = await second.advance((await repo.get("t1"))!);

    // It picks up the same subtask rather than skipping it, and does not re-plan.
    expect(answered.calls.map((c) => c.label)).toContain("build:build-1");
    expect(answered.calls.map((c) => c.label)).not.toContain("plan:build");
    expect(report.outcome).toMatchObject({ kind: "awaitingApproval" });
  });

  it("stops at a failed subtask instead of pushing on", async () => {
    // The route is a chain of preconditions; continuing past a failure would
    // make every later stage meaningless.
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "build:build-1": { ok: false, text: "" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);
    expect(report.outcome).toMatchObject({ kind: "blocked", stageId: "build" });
    // build-2 must never have been attempted.
    expect(sessions.calls.map((c) => c.label)).not.toContain("build:build-2");
    expect(sessions.calls.map((c) => c.label)).not.toContain("behaviour:behaviour-1");
  });

  it("runs a stage whole when the plan cannot be parsed", async () => {
    const sessions = fakeSessions({
      "plan:": { text: "I don't think this needs splitting." },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);
    expect(report.steps.join(" ")).toContain("running it whole");
    expect(sessions.calls.map((c) => c.label)).toContain("build:build-1");
    expect(report.outcome).toMatchObject({ kind: "awaitingApproval" });
  });

  it("blocks when the planning session itself fails", async () => {
    const sessions = fakeSessions({ "plan:": { ok: false, text: "" } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);
    expect(report.outcome).toMatchObject({ kind: "blocked", stageId: "build" });
  });

  it("appends rule-derived reviews as the diff grows", async () => {
    const sessions = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { repo, runner } = makeRunner(sessions, {
      paths: ["db/migrations/001.sql"],
      rules: {
        rules: [
          {
            id: "sql",
            reason: "SQL changed.",
            pathPattern: "\\.sql$",
            stage: {
              id: "sql-review",
              label: "SQL review",
              kind: "domainReview",
              intent: "Review the SQL.",
            },
          },
        ],
        problems: [],
        noRulesConfigured: false,
        sourcePath: "C:/repos/app/.taskworkspaces/review-rules.json",
      },
    });
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);
    expect(report.steps.join(" ")).toContain("SQL review");
    // The appended stage was actually run, before the gate.
    expect(sessions.calls.map((c) => c.label)).toContain("sql-review:sql-review-1");
    expect(report.outcome).toMatchObject({ kind: "awaitingApproval" });

    const ids = (await repo.get("t1"))?.pipeline?.stages.map((s) => s.id) ?? [];
    expect(ids.indexOf("sql-review")).toBeLessThan(ids.indexOf("human-verification"));
  });

  it("stops immediately when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { repo, runner } = makeRunner(fakeSessions());
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!, controller.signal);
    expect(report.outcome).toEqual({ kind: "cancelled" });
  });

  it("reports done once the gate has been approved", async () => {
    const sessions = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    // Simulate the human approving, then advance again.
    const saved = (await repo.get("t1"))!;
    const approved = {
      ...saved,
      pipeline: {
        ...saved.pipeline!,
        stages: saved.pipeline!.stages.map((s) =>
          s.id === "human-verification" ? { ...s, status: "passed" as const } : s,
        ),
        currentStage: undefined,
      },
    };
    await repo.save(approved);

    const report = await runner.advance(approved);
    expect(report.outcome).toEqual({ kind: "done" });
  });
});

describe("stopping a route", () => {
  /**
   * Sessions that cancel the route from inside the first *subtask* run. The
   * split comes first and must succeed, or there would be no subtask to stop.
   */
  function stoppingSessions(cancel: () => void): StageSessionRunner & {
    labels: string[];
  } {
    const labels: string[] = [];
    return {
      labels,
      async run(_task, _prompt, label) {
        labels.push(label);
        if (label.startsWith("plan:")) return { ok: true, text: PLAN_REPLY };
        if (labels.filter((l) => !l.startsWith("plan:")).length === 1) cancel();
        return { ok: true, text: "done" };
      },
    };
  }

  it("stops after the in-flight subtask instead of starting the next", async () => {
    let cancel = () => {};
    const sessions = stoppingSessions(() => cancel());
    const { runner } = makeRunner(sessions);
    cancel = () => runner.cancel("t1");

    const report = await runner.advance(task());

    expect(report.outcome).toEqual({ kind: "cancelled" });
    // The split plus exactly one subtask: the second subtask never started.
    expect(sessions.labels.filter((l) => !l.startsWith("plan:"))).toHaveLength(1);
  });

  it("reverts the stopped subtask to pending, so the route resumes from it", async () => {
    // Stopping the agent kills the session, which looks like a finished turn from
    // the runner's side. Recording it as done would silently pass a stage.
    let cancel = () => {};
    const sessions = stoppingSessions(() => cancel());
    const { repo, runner } = makeRunner(sessions);
    cancel = () => runner.cancel("t1");

    await runner.advance(task());

    const stage = (await repo.get("t1"))!.pipeline!.stages.find((s) => s.id === "build")!;
    expect(stage.subtasks.map((s) => s.status)).not.toContain("done");
    expect(stage.subtasks.every((s) => s.status === "pending")).toBe(true);
  });

  it("resumes the stopped subtask on the next advance", async () => {
    let cancel = () => {};
    const stopping = stoppingSessions(() => cancel());
    const { repo, runner } = makeRunner(stopping);
    cancel = () => runner.cancel("t1");
    await runner.advance(task());

    const resumed = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { runner: second } = makeRunner(resumed, { repo });
    const report = await second.advance((await repo.get("t1"))!);

    // It ran the interrupted subtask rather than skipping past it.
    expect(resumed.calls.some((c) => c.label.startsWith("build:"))).toBe(true);
    expect(report.outcome).not.toEqual({ kind: "cancelled" });
  });

  it("cancelling an idle task is a no-op", () => {
    const { runner } = makeRunner(fakeSessions());
    expect(() => runner.cancel("t1")).not.toThrow();
    expect(runner.isRunning("t1")).toBe(false);
  });

  it("reports a route as running only while it is in flight", async () => {
    const { runner } = makeRunner(fakeSessions({ "plan:": { text: PLAN_REPLY } }));
    const inFlight = runner.advance(task());
    expect(runner.isRunning("t1")).toBe(true);
    await inFlight;
    expect(runner.isRunning("t1")).toBe(false);
  });

  it("honours a caller signal that is already aborted", async () => {
    const sessions = fakeSessions();
    const { runner } = makeRunner(sessions);
    const controller = new AbortController();
    controller.abort();

    const report = await runner.advance(task(), controller.signal);

    expect(report.outcome).toEqual({ kind: "cancelled" });
    expect(sessions.calls).toHaveLength(0);
  });
});

describe("a subtask left running by a closed extension host", () => {
  /** The state a host killed mid-subtask leaves behind. */
  async function strandedTask(repo: InMemoryTaskRepository) {
    const seed = task();
    const pipeline = structuredClone(seed.pipeline!);
    const stage = pipeline.stages.find((s) => s.id === "build")!;
    stage.status = "running";
    stage.subtasks = [
      { id: "build-1", title: "Part one", prompt: "do one", status: "active" },
      { id: "build-2", title: "Part two", prompt: "do two", status: "pending" },
    ];
    pipeline.currentStage = "build";
    await repo.save({ ...seed, pipeline });
    return (await repo.get("t1"))!;
  }

  it("is reclaimed rather than blocking the route forever", async () => {
    // `startSubtask` persists "running" before the session starts, but sessions
    // die with the host. Without reclaiming, every later advance reports "a
    // subtask is already in flight" and there is no way back.
    const repo = new InMemoryTaskRepository();
    const stranded = await strandedTask(repo);

    const sessions = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { runner } = makeRunner(sessions, { repo });
    const report = await runner.advance(stranded);

    expect(report.steps.some((s) => s.includes("Reclaimed"))).toBe(true);
    expect(report.outcome).not.toMatchObject({ kind: "blocked" });
    expect(sessions.calls.some((c) => c.label === "build:build-1")).toBe(true);
  });

  it("still blocks a genuinely concurrent advance on the same task", async () => {
    // Two advances at once must not run the same subtask twice.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const sessions: StageSessionRunner = {
      async run(_task, _prompt, label) {
        if (label.startsWith("plan:")) return { ok: true, text: PLAN_REPLY };
        if (++runs === 1) await gate;
        return { ok: true, text: "done" };
      },
    };
    const repo = new InMemoryTaskRepository();
    const { runner } = makeRunner(sessions, { repo });

    const first = runner.advance(task());
    await new Promise((r) => setTimeout(r, 20)); // let it reach a subtask

    const second = await runner.advance((await repo.get("t1"))!);
    expect(second.outcome).toMatchObject({ kind: "blocked" });

    release();
    await first;
  });
});
