import { describe, it, expect } from "vitest";
import { PipelineRunner, StageSessionRunner } from "./pipelineRunner";
import { ReviewPlanService, ChangedPathsSource } from "./reviewPlanService";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { createPipeline } from "../domain/pipelineEngine";
import { RouteDefinition } from "../domain/taskRoute";
import { ReviewRule } from "../domain/reviewRules";
import { Logger } from "../logging/logger";
import { LoadedReviewRules } from "./reviewRulesService";
import { ok } from "../utilities/result";
import { PermissionDenial } from "../agents/permissionDenials";

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
    onDenial?: (task: TaskWorkspace, denial: PermissionDenial) => void;
    pauseOnDenial?: boolean;
    /** Current project config, for resolving stage models afresh. */
    harness?: { routes: RouteDefinition[]; rules: ReviewRule[] };
    /** The branch the worktree reports being on, for the branch guard. */
    currentBranch?: string;
  } = {},
) {
  const repo = options.repo ?? new InMemoryTaskRepository();
  const changed: ChangedPathsSource = {
    getChangedPaths: async () => ok(options.paths ?? []),
  };
  const rules: LoadedReviewRules =
    options.rules ?? { rules: [], problems: [], noRulesConfigured: true };
  const plans = new ReviewPlanService(changed, repo, logger, () => rules);
  return {
    repo,
    runner: new PipelineRunner(
      sessions,
      repo,
      plans,
      logger,
      () => undefined,
      options.onDenial,
      () => options.pauseOnDenial ?? true,
      () => options.harness,
      options.currentBranch === undefined
        ? undefined
        : async () => options.currentBranch,
    ),
  };
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
      questions: ["Which dealer fields are in scope?"],
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

describe("per-stage model", () => {
  /** Records the options each call received alongside its label. */
  function recordingSessions(): StageSessionRunner & {
    seen: { label: string; model?: string }[];
  } {
    const seen: { label: string; model?: string }[] = [];
    return {
      seen,
      async run(_task, _prompt, label, options) {
        seen.push({ label, model: options?.model });
        return { ok: true, text: label.startsWith("plan:") ? PLAN_REPLY : "done" };
      },
    };
  }

  function routeWithModels(): RouteDefinition {
    return {
      ...ROUTE,
      stages: ROUTE.stages.map((s) =>
        s.id === "build" ? { ...s, model: "sonnet" } : s,
      ),
    };
  }

  it("reaches the session runner for the stage that declared it", async () => {
    const sessions = recordingSessions();
    const { runner } = makeRunner(sessions);
    await runner.advance({ ...task(), pipeline: createPipeline(routeWithModels()) });

    const build = sessions.seen.filter((s) => s.label.startsWith("build:"));
    expect(build.length).toBeGreaterThan(0);
    expect(build.every((s) => s.model === "sonnet")).toBe(true);
  });

  it("applies to the stage's own split-planning session", async () => {
    // Deciding how to break a stage up is the same kind of work as the stage.
    const sessions = recordingSessions();
    const { runner } = makeRunner(sessions);
    await runner.advance({ ...task(), pipeline: createPipeline(routeWithModels()) });

    expect(sessions.seen.find((s) => s.label === "plan:build")?.model).toBe("sonnet");
  });

  it("leaves stages that declare no model on the configured default", async () => {
    const sessions = recordingSessions();
    const { runner } = makeRunner(sessions);
    await runner.advance({ ...task(), pipeline: createPipeline(routeWithModels()) });

    const others = sessions.seen.filter((s) => !s.label.includes("build"));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((s) => s.model === undefined)).toBe(true);
  });

  it("survives a round-trip through the repository", async () => {
    // The pipeline is plain JSON in a Memento; a field that does not normalise
    // back would silently revert every stage to the default model.
    const sessions = recordingSessions();
    const { repo, runner } = makeRunner(sessions);
    const seeded = { ...task(), pipeline: createPipeline(routeWithModels()) };
    await repo.save(seeded);

    const reloaded = (await repo.get("t1"))!;
    const build = reloaded.pipeline!.stages.find((s) => s.id === "build")!;
    expect(build.model).toBe("sonnet");
    void runner;
  });

  it("picks up a model added to config after the task was created", async () => {
    // The reported bug: harness.json was edited to say sonnet, the task had
    // already snapshotted its stages, and the stage went on running opus with
    // nothing to say why. Config is read per advance, so the next stage obeys it.
    const sessions = recordingSessions();
    const { runner } = makeRunner(sessions, {
      harness: { routes: [routeWithModels()], rules: [] },
    });
    // The stored pipeline predates the edit: no stage carries a model.
    await runner.advance(task());

    const build = sessions.seen.filter((s) => s.label.includes("build"));
    expect(build.length).toBeGreaterThan(0);
    expect(build.every((s) => s.model === "sonnet")).toBe(true);
  });

  it("lets config remove an override a stored stage still carries", async () => {
    const sessions = recordingSessions();
    const { runner } = makeRunner(sessions, {
      harness: { routes: [ROUTE], rules: [] },
    });
    await runner.advance({ ...task(), pipeline: createPipeline(routeWithModels()) });

    const build = sessions.seen.filter((s) => s.label.includes("build"));
    expect(build.length).toBeGreaterThan(0);
    expect(build.every((s) => s.model === undefined)).toBe(true);
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

describe("a question the runner recorded", () => {
  it("is persisted with the task, so closing the panel loses nothing", async () => {
    // The session that asked has ended, so a question held only in a dialog was
    // unrecoverable — dismissing it meant re-running the stage to see it again.
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "build:build-1": { text: "NEEDS-INFO:\n1. Which tenants?\n2. Include DR?" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const pending = (await repo.get("t1"))!.pipeline!.pendingQuestion!;
    expect(pending.stageId).toBe("build");
    expect(pending.stageName).toBe("Build");
    expect(pending.subtaskId).toBe("build-1");
    expect(pending.items.map((i) => i.text)).toEqual(["Which tenants?", "Include DR?"]);
    expect(pending.askedAt).not.toBe("");
  });

  it("leaves the subtask pending, so answering resumes rather than skips", async () => {
    const sessions = fakeSessions({
      "plan:": { text: PLAN_REPLY },
      "build:build-1": { text: "NEEDS-INFO: Which tenants?" },
    });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const stage = (await repo.get("t1"))!.pipeline!.stages.find((s) => s.id === "build")!;
    expect(stage.subtasks.find((s) => s.id === "build-1")!.status).toBe("pending");
  });
});

describe("permission refusals", () => {
  /** Sessions that report a refused tool call, as the real adapter does. */
  function denyingSessions(): StageSessionRunner {
    return {
      async run(_task, _prompt, label, options) {
        if (label.startsWith("plan:")) return { ok: true, text: PLAN_REPLY };
        const denial: PermissionDenial = {
          tool: "PowerShell",
          command: "tools/jira/Get-JiraAttachment.ps1 -IssueKey X",
          reason: "This command requires approval",
          attempts: 3,
        };
        // The real adapter announces the refusal as it happens, then returns it.
        options?.onDenial?.(denial);
        return { ok: true, text: "done", denials: [denial] };
      },
    };
  }

  it("pauses the route, even though the stage itself succeeded", async () => {
    // A stage that could not run a command it judged necessary has not done its
    // job; carrying on buries that behind whatever it did instead.
    const { repo, runner } = makeRunner(denyingSessions());
    await repo.save(task());
    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.outcome).toMatchObject({
      kind: "denied",
      stageId: "build",
      subtaskId: "build-1",
    });
    expect(report.denials[0].tool).toBe("PowerShell");
    expect(report.steps.join(" ")).toContain("denied by permissions");
  });

  it("leaves the subtask pending, so granting the rule resumes it", async () => {
    const { repo, runner } = makeRunner(denyingSessions());
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const stage = (await repo.get("t1"))!.pipeline!.stages.find((s) => s.id === "build")!;
    expect(stage.subtasks.find((s) => s.id === "build-1")!.status).toBe("pending");
    expect(stage.status).not.toBe("failed");
  });

  it("reports the refusal live, while the stage is still running", async () => {
    // The refusal happens seconds in; waiting for the advance to end wastes the
    // very minutes this is meant to save.
    const seen: PermissionDenial[] = [];
    const { repo, runner } = makeRunner(denyingSessions(), {
      onDenial: (_task, denial) => seen.push(denial),
    });
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe("PowerShell");
  });

  it("carries on when pausing is switched off, but still reports", async () => {
    const { repo, runner } = makeRunner(denyingSessions(), { pauseOnDenial: false });
    await repo.save(task());
    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.outcome).toMatchObject({ kind: "awaitingApproval" });
    expect(report.denials.length).toBeGreaterThan(0);
  });

  it("reports nothing when no call was refused", async () => {
    // In bypassPermissions nothing is denied, so this stays quiet.
    const { repo, runner } = makeRunner(fakeSessions({ "plan:": { text: PLAN_REPLY } }));
    await repo.save(task());
    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.denials).toEqual([]);
    expect(report.steps.join(" ")).not.toContain("denied");
  });

  it("does not carry refusals over from a previous advance", async () => {
    const { repo, runner } = makeRunner(denyingSessions(), { pauseOnDenial: false });
    await repo.save(task());
    const first = await runner.advance((await repo.get("t1"))!);
    expect(first.denials.length).toBeGreaterThan(0);

    // Nothing left to run, so this advance refuses nothing of its own.
    const second = await runner.advance((await repo.get("t1"))!);
    expect(second.denials).toEqual([]);
  });
});

describe("refusals persisted for the sidebar", () => {
  it("are stored on the stage that hit them, with their rules", async () => {
    // A notification is transient and stacks across tasks; the row under the
    // stage is what survives a dismissal and a window reload.
    const sessions: StageSessionRunner = {
      async run(_task, _prompt, label) {
        if (label.startsWith("plan:")) return { ok: true, text: PLAN_REPLY };
        return {
          ok: true,
          text: "done",
          denials: [
            {
              tool: "PowerShell",
              command: "tools/jira/Get-JiraAttachment.ps1 -IssueKey X",
              reason: "This command requires approval",
              attempts: 5,
            },
          ],
        };
      },
    };
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());
    await runner.advance((await repo.get("t1"))!);

    const pending = (await repo.get("t1"))!.pipeline!.pendingDenials!;
    expect(pending.stageId).toBe("build");
    expect(pending.subtaskId).toBe("build-1");
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0].attempts).toBe(5);
    expect(pending.items[0].rule).toBe(
      "PowerShell(tools/jira/Get-JiraAttachment.ps1:*)",
    );
  });
});

describe("the branch guard", () => {
  it("refuses to run a stage when the worktree moved to another branch", async () => {
    // The reported failure: a rule review spliced in behind a UAT promotion ran on
    // the branch the promotion left checked out, found no migration scripts, and
    // reported that absence truthfully about a tree nobody had asked about.
    const sessions = fakeSessions({ "": { text: "done" } });
    const { runner } = makeRunner(sessions, { currentBranch: "LIVE_MultiMarket" });
    const subject = { ...task(), intendedBranch: "bug/dealer-mapping" };

    const report = await runner.advance(subject);

    expect(report.outcome.kind).toBe("blocked");
    expect(sessions.calls).toHaveLength(0);
    expect(report.steps.join(" ")).toContain("LIVE_MultiMarket");
  });

  it("runs normally when the worktree is where it should be", async () => {
    const sessions = fakeSessions({ "": { text: "done" } });
    const { runner } = makeRunner(sessions, { currentBranch: "bug/dealer-mapping" });
    const subject = { ...task(), intendedBranch: "bug/dealer-mapping" };

    await runner.advance(subject);
    expect(sessions.calls.length).toBeGreaterThan(0);
  });

  it("lets a stage that may move the worktree run anyway", async () => {
    // A UAT promotion needs a PR, so moving is its work rather than a mistake.
    const sessions = fakeSessions({ "": { text: "done" } });
    const { runner } = makeRunner(sessions, { currentBranch: "LIVE_MultiMarket" });
    const subject = { ...task(), intendedBranch: "bug/dealer-mapping" };
    subject.pipeline = {
      ...subject.pipeline!,
      stages: subject.pipeline!.stages.map((s) => ({ ...s, mayChangeBranch: true })),
    };

    await runner.advance(subject);
    expect(sessions.calls.length).toBeGreaterThan(0);
  });


  it("does not evaluate review rules while the worktree is on another branch", async () => {
    // Measured on a real task: from a promotion branch the changed-path set was a
    // diff of two lineages -- 9,569 files instead of a handful -- so every rule in
    // the project matched and a tooling review and an ETL review were queued onto a
    // task that had touched one stored procedure.
    const sessions = fakeSessions({ "": { text: "done" } });
    const { runner, repo } = makeRunner(sessions, {
      currentBranch: "promote/x",
      paths: ["tools/sql/x.sql"],
      rules: {
        rules: [
          {
            id: "etl",
            reason: "ETL touched",
            when: { anyPathMatches: ["**/*.sql"] },
            stage: { id: "r-etl", label: "ETL review", kind: "domainReview", intent: "i" },
          },
        ] as never,
        problems: [],
        noRulesConfigured: false,
      },
    });
    const subject = { ...task(), intendedBranch: "bug/dealer-mapping" };
    await repo.save(subject);

    const report = await runner.advance(subject);

    const saved = await repo.get(subject.id);
    expect(saved?.pipeline?.stages.some((s) => s.id === "r-etl")).toBe(false);
    expect(report.steps.join(" ")).toContain("Skipped review rules");
  });

  it("does nothing when no branch source is wired in", async () => {
    // A headless run without one must behave exactly as before.
    const sessions = fakeSessions({ "": { text: "done" } });
    const { runner } = makeRunner(sessions);
    await runner.advance({ ...task(), intendedBranch: "something/else" });
    expect(sessions.calls.length).toBeGreaterThan(0);
  });
});
