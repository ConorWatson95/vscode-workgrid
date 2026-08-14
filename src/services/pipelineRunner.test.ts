import { describe, it, expect } from "vitest";
import { PipelineRunner, StageSessionRunner } from "./pipelineRunner";
import { DiscardSelection } from "../domain/worktreeDiscard";
import { ReviewPlanService, ChangedPathsSource } from "./reviewPlanService";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { correctStage, createPipeline } from "../domain/pipelineEngine";
import { RouteDefinition } from "../domain/taskRoute";
import { ReviewRule } from "../domain/reviewRules";
import { Logger } from "../logging/logger";
import { LoadedReviewRules } from "./reviewRulesService";
import { ok } from "../utilities/result";
import { PermissionDenial } from "../agents/permissionDenials";
import { WorktreeClaimService } from "./worktreeClaimService";

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
      // `key !== undefined`, not `key ?`: "" is a legitimate catch-all prefix and is
      // falsy, so a reply registered under it was silently ignored and every caller
      // got the default "ok, done" instead of what it asked for.
      const reply = key !== undefined ? replies[key] : undefined;
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
    /** Canned verification outcomes, keyed by the command run. */
    verify?: Record<string, { exitCode: number; output?: string; spawnError?: string }>;
    /** Canned worktree files, keyed by path relative to the worktree. */
    files?: Record<string, string>;
    /**
     * Cumulative human-wait readings, consumed one per call.
     *
     * A list rather than a number because the runner samples the total either side of
     * each session and keeps the difference — so a test has to be able to move it
     * while the session is notionally running.
     */
    humanWaits?: number[];
    /** How old an unowned `active` subtask must be before `reclaimStale` takes it. */
    staleAfterMs?: number;
    /** What the declared-path discard reports having done, if the project declared any. */
    discard?: DiscardSelection;
  } = {},
) {
  const repo = options.repo ?? new InMemoryTaskRepository();
  const verified: string[] = [];
  // Ordering is the whole claim: a discard after the check has read the tree fixes
  // nothing, so the two record into one list rather than two.
  const events: string[] = [];
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
      options.verify === undefined
        ? undefined
        : {
            run: async (command) => {
              verified.push(command);
              events.push(`verify:${command}`);
              const canned = options.verify?.[command] ?? { exitCode: 0 };
              return { exitCode: canned.exitCode, output: canned.output ?? "", spawnError: canned.spawnError };
            },
          },
      options.files === undefined
        ? undefined
        : async (_worktreePath, relativePath) => options.files?.[relativePath],
      undefined,
      options.humanWaits === undefined
        ? undefined
        : () => {
            const readings = options.humanWaits!;
            // The last reading stands once the list runs out, so a run with more
            // subtasks than readings reports no further waits rather than throwing.
            return readings.length > 1 ? readings.shift()! : readings[0];
          },
      () => options.staleAfterMs ?? 60 * 60 * 1000,
      options.discard === undefined
        ? undefined
        : async () => {
            events.push("discard");
            return options.discard;
          },
    ),
    verified,
    events,
  };
}

const PLAN_REPLY = "1. Part one — do one.\n2. Part two — do two.";

/**
 * Time an operator spent answering must not be recorded as the model working.
 *
 * `ask_user` returns its answer into the waiting turn, so the wait sits inside the
 * subtask's own span. A real 23-stage route reported 4% idle — apparently not
 * supervision-bound — while its 32-minute implementation stage had asked two
 * questions. The runner samples a cumulative total either side of the session, the
 * way it snapshots the worktree list, because the wait ends several layers below here.
 */
describe("human wait attribution", () => {
  it("records what a subtask waited, as the difference between two readings", async () => {
    const sessions = fakeSessions({ "plan:": { text: "1. Only one — do it." } });
    // Read before the first session, then after: 0 -> 90s.
    const { repo, runner } = makeRunner(sessions, { humanWaits: [0, 90_000] });
    await repo.save(task());

    await runner.advance((await repo.get("t1"))!);

    const saved = await repo.get("t1");
    const build = saved?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.subtasks[0].activity?.blockedOnHumanMs).toBe(90_000);
  });

  it("attributes a wait to the subtask it held up, not to its siblings", async () => {
    const sessions = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    // Splitting takes no reading. Subtask one reads 0 then 60s; subtask two reads 60s
    // both times, because the total has not moved since.
    const { repo, runner } = makeRunner(sessions, {
      humanWaits: [0, 60_000, 60_000, 60_000],
    });
    await repo.save(task());

    await runner.advance((await repo.get("t1"))!);

    const build = (await repo.get("t1"))?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.subtasks[0].activity?.blockedOnHumanMs).toBe(60_000);
    // The second subtask waited on nothing, and must not inherit the first's wait.
    expect(build?.subtasks[1].activity?.blockedOnHumanMs).toBeUndefined();
  });

  // A route where nobody asked anything must round-trip unchanged rather than gaining
  // a zero field on every subtask.
  it("records nothing when no question was asked", async () => {
    const sessions = fakeSessions({ "plan:": { text: "1. Only one — do it." } });
    const { repo, runner } = makeRunner(sessions, { humanWaits: [4_000] });
    await repo.save(task());

    await runner.advance((await repo.get("t1"))!);

    const build = (await repo.get("t1"))?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.subtasks[0].activity?.blockedOnHumanMs).toBeUndefined();
  });

  it("behaves exactly as before when no wait source is injected", async () => {
    const sessions = fakeSessions({ "plan:": { text: "1. Only one — do it." } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.outcome).toMatchObject({ kind: "awaitingApproval" });
    const build = (await repo.get("t1"))?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.subtasks[0].activity?.blockedOnHumanMs).toBeUndefined();
  });

  it("says so in the step list, so the report explains a long stage", async () => {
    const sessions = fakeSessions({ "plan:": { text: "1. Only one — do it." } });
    const { repo, runner } = makeRunner(sessions, { humanWaits: [0, 125_000] });
    await repo.save(task());

    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.steps.some((step) => /125s waiting on an answer/.test(step))).toBe(true);
  });
});

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

describe("work every stage declined", () => {
  /** Build, then a stage that ships — the shape that failed on a live publish. */
  const shippingRoute = (): RouteDefinition => ({
    ...ROUTE,
    stages: [
      { ...ROUTE.stages[0], splittable: false },
      {
        id: "publish",
        label: "Live publish",
        kind: "deployment",
        intent: "Publish to live.",
        splittable: false,
        gate: "auto",
      },
    ],
  });

  const shippingTask = (): TaskWorkspace => ({
    ...task(),
    pipeline: createPipeline(shippingRoute()),
  });

  const REPLY =
    "Corrected the mapping.\nDEFERRED: the export structure exists on live only and is missing";

  it("holds before the deployment instead of running it", async () => {
    const sessions = fakeSessions({ "build:": { text: REPLY } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(shippingTask());

    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.outcome).toMatchObject({ kind: "deferredWork", stageId: "publish" });
    // The publish stage never got a session at all, which is the entire point.
    expect(sessions.calls.some((c) => c.label.startsWith("publish:"))).toBe(false);
  });

  it("names what was declined and which stage declined it", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "build:": { text: REPLY } }));
    await repo.save(shippingTask());
    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.outcome).toMatchObject({
      kind: "deferredWork",
      items: [{ text: "the export structure exists on live only and is missing", raisedByStageName: "Build" }],
    });
  });

  it("keeps the marker out of the stage's recorded reply", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "build:": { text: REPLY } }));
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    const reply = (await repo.get("t1"))!.pipeline!.stages[0].subtasks[0].reply ?? "";
    expect(reply).toContain("Corrected the mapping");
    expect(reply).not.toContain("DEFERRED:");
  });

  it("records what a failed stage declined, since it still saw the gap", async () => {
    const { repo, runner } = makeRunner(
      fakeSessions({ "build:": { ok: false, text: REPLY } }),
    );
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    expect((await repo.get("t1"))!.pipeline!.deferrals).toHaveLength(1);
  });
});

describe("steps only the operator can take", () => {
  const shippingRoute = (): RouteDefinition => ({
    ...ROUTE,
    stages: [
      {
        id: "promote",
        label: "Promote to UAT",
        kind: "deployment",
        intent: "Promote.",
        splittable: false,
        gate: "auto",
      },
      { ...ROUTE.stages[1] },
    ],
  });

  const shippingTask = (): TaskWorkspace => ({
    ...task(),
    pipeline: createPipeline(shippingRoute()),
  });

  const REPLY =
    "Cherry-picked 4aba94e onto UAT.\n" +
    "ACTION: open https://bitbucket.org/x/pull-requests/9?dest=UAT and merge it";

  it("holds the stage rather than advancing past the step", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "promote:": { text: REPLY } }));
    await repo.save(shippingTask());

    await runner.advance((await repo.get("t1"))!);

    const stage = (await repo.get("t1"))!.pipeline!.stages[0];
    expect(stage.status).toBe("awaiting-approval");
  });

  it("records the step against the stage, with its URL intact", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "promote:": { text: REPLY } }));
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    const items = (await repo.get("t1"))!.pipeline!.stages[0].checklist ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("action");
    expect(items[0].text).toContain("pull-requests/9?dest=UAT");
    expect(items[0].checked).toBe(false);
  });

  it("keeps the marker out of the reply the report shows", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "promote:": { text: REPLY } }));
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    const subtask = (await repo.get("t1"))!.pipeline!.stages[0].subtasks[0];
    expect(subtask.reply).toContain("Cherry-picked");
    expect(subtask.reply).not.toContain("ACTION:");
  });

  it("does not hold a stage that named no steps", async () => {
    const { repo, runner } = makeRunner(
      fakeSessions({ "promote:": { text: "Cherry-picked and pushed." } }),
    );
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    expect((await repo.get("t1"))!.pipeline!.stages[0].status).toBe("passed");
  });
});

describe("a stage that says it did not do its work", () => {
  /**
   * The exact shape that let a live publish pass having published nothing: a
   * deployment stage with no `verify`, whose agent correctly refused because nothing
   * was committed, and whose refusal was recorded as "done" because the session ended
   * without error.
   */
  const shippingRoute = (): RouteDefinition => ({
    ...ROUTE,
    stages: [
      {
        id: "publish",
        label: "Live publish",
        kind: "deployment",
        intent: "Publish to live.",
        splittable: false,
        gate: "auto",
      },
    ],
  });

  const shippingTask = (): TaskWorkspace => ({
    ...task(),
    pipeline: createPipeline(shippingRoute()),
  });

  const REFUSAL =
    "The plan's step 1 prerequisite is unmet. git log --all --grep=NMGB-2795 returns " +
    "no commits, so there is no SHA to cherry-pick.\n" +
    "BLOCKED: nothing for this ticket is committed anywhere, so there is nothing to publish";

  it("holds the stage instead of passing it", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "publish:": { text: REFUSAL } }));
    await repo.save(shippingTask());

    await runner.advance((await repo.get("t1"))!);

    const stage = (await repo.get("t1"))!.pipeline!.stages[0];
    // Not "passed", which is what it used to be.
    expect(stage.status).toBe("awaiting-approval");
  });

  it("says what was missing rather than only that it stopped", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "publish:": { text: REFUSAL } }));
    await repo.save(shippingTask());

    const report = await runner.advance((await repo.get("t1"))!);

    expect(report.steps.join(" ")).toContain("nothing for this ticket is committed");
  });

  it("keeps the marker out of the reply the report shows", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "publish:": { text: REFUSAL } }));
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    const subtask = (await repo.get("t1"))!.pipeline!.stages[0].subtasks[0];
    expect(subtask.reply).toContain("no commits");
    expect(subtask.reply).not.toContain("BLOCKED:");
  });

  it("passes a stage that did its work and said nothing about being blocked", async () => {
    const { repo, runner } = makeRunner(
      fakeSessions({ "publish:": { text: "Published to all three live branches." } }),
    );
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    expect((await repo.get("t1"))!.pipeline!.stages[0].status).toBe("passed");
  });

  it("does not read the word in prose as a refusal", async () => {
    // "blocked" is an ordinary word in a deployment report, and treating a mention of
    // it as a refusal would hold routes that worked.
    const { repo, runner } = makeRunner(
      fakeSessions({
        "publish:": { text: "Published. The old job was blocked on a lock, now cleared." },
      }),
    );
    await repo.save(shippingTask());
    await runner.advance((await repo.get("t1"))!);

    expect((await repo.get("t1"))!.pipeline!.stages[0].status).toBe("passed");
  });
});

describe("the handoff carried between stages", () => {
  /** The same route, with the first stage marked as one worth carrying forward. */
  const handoffRoute = (): RouteDefinition => ({
    ...ROUTE,
    stages: ROUTE.stages.map((s) =>
      s.id === "build" ? { ...s, splittable: false, handoff: true } : s,
    ),
  });

  const handoffTask = (): TaskWorkspace => ({
    ...task(),
    pipeline: createPipeline(handoffRoute()),
  });

  const REPLY = [
    "I corrected the mapping in the customer editor.",
    "",
    "HANDOFF:",
    "## Summary",
    "Dealer id now survives an edit.",
    "## Decisions",
    "- Kept the legacy column; three reports still read it.",
    "## Next step",
    "Exercise an edit against staging.",
  ].join("\n");

  it("carries the block forward and keeps it out of the report", async () => {
    const { repo, runner } = makeRunner(fakeSessions({ "build:": { text: REPLY } }));
    await repo.save(handoffTask());
    await runner.advance((await repo.get("t1"))!);

    const pipeline = (await repo.get("t1"))!.pipeline!;
    const handoff = pipeline.handoffs?.[0];
    expect(handoff?.text).toContain("Kept the legacy column");
    expect(handoff?.text).toContain("Exercise an edit against staging");
    // The marker is protocol between harness and agent; a reader of the report
    // should never see it, exactly as with the verdict line.
    const reply = pipeline.stages[0].subtasks[0].reply ?? "";
    expect(reply).toContain("I corrected the mapping");
    expect(reply).not.toContain("HANDOFF:");
    expect(reply).not.toContain("## Decisions");
  });

  it("gives a later stage the handoff in its prompt", async () => {
    const sessions = fakeSessions({ "build:": { text: REPLY } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(handoffTask());
    await runner.advance((await repo.get("t1"))!);

    const later = sessions.calls.find((c) => c.label.startsWith("behaviour:"));
    expect(later?.prompt).toContain("Kept the legacy column");
  });

  it("withholds it from a later stage on the no-handoffs arm, but still records it", async () => {
    // The other side of the measurement. Suppressed at delivery rather than at
    // recording, so both arms stay comparable on what the stages actually did and the
    // run is still readable — an experiment that destroys its own evidence measures
    // one number and answers no question about why.
    const sessions = fakeSessions({ "build:": { text: REPLY } });
    const { repo, runner } = makeRunner(sessions);
    const task = handoffTask();
    task.pipeline!.experiment = { id: "handoffs", arm: "no-handoffs", at: "t" };
    await repo.save(task);
    await runner.advance((await repo.get("t1"))!);

    const later = sessions.calls.find((c) => c.label.startsWith("behaviour:"));
    expect(later?.prompt).not.toContain("Kept the legacy column");
    expect((await repo.get("t1"))!.pipeline!.handoffs?.[0]?.text).toContain(
      "Kept the legacy column",
    );
  });

  it("falls back to the whole reply when the stage wrote no block", async () => {
    // The block is asked for in a prompt, so it can be ignored — and a stage that
    // ignores it must still contribute something rather than silently nothing.
    const { repo, runner } = makeRunner(
      fakeSessions({ "build:": { text: "Fixed it. No block here." } }),
    );
    await repo.save(handoffTask());
    await runner.advance((await repo.get("t1"))!);

    expect((await repo.get("t1"))!.pipeline!.handoffs?.[0]?.text).toBe(
      "Fixed it. No block here.",
    );
  });

  it("keeps the decisions and drops the file list when the block is too long", async () => {
    // The point of parsing rather than cutting: a blind truncation keeps whatever
    // came first, and what a later stage needs is at the end.
    const long = [
      "Report.",
      "HANDOFF:",
      "## Summary",
      "Short.",
      "## Files",
      ...Array.from({ length: 200 }, (_, i) => `- src/generated/file-${i}.ts`),
      "## Decisions",
      "- The dealer id must stay nullable for the legacy import.",
      "## Next step",
      "Run the import against staging.",
    ].join("\n");
    const { repo, runner } = makeRunner(fakeSessions({ "build:": { text: long } }));
    await repo.save(handoffTask());
    await runner.advance((await repo.get("t1"))!);

    const text = (await repo.get("t1"))!.pipeline!.handoffs![0].text;
    expect(text).toContain("must stay nullable");
    expect(text).toContain("Run the import against staging");
    expect(text).not.toContain("src/generated/file-150.ts");
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

describe("an implausible changed-path set", () => {
  it("does not apply rules when the changed-path set is a branch-lineage diff", async () => {
    // The branch guard catches the cause we found; this catches the shape whatever
    // the cause -- a stale base branch, a rebase, a squashed merge.
    const sessions = fakeSessions({ "": { text: "done" } });
    const { runner, repo } = makeRunner(sessions, {
      paths: Array.from({ length: 2000 }, (_, i) => `tools/sql/f${i}.sql`),
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
    const subject = task();
    await repo.save(subject);

    const report = await runner.advance(subject);

    const saved = await repo.get(subject.id);
    expect(saved?.pipeline?.stages.some((s) => s.id === "r-etl")).toBe(false);
    expect(report.steps.join(" ")).toContain("branch-lineage diff");
  });

  it("applies rules normally for a change of a believable size", async () => {
    const sessions = fakeSessions({ "": { text: "done" } });
    const { runner, repo } = makeRunner(sessions, {
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
    const subject = task();
    await repo.save(subject);

    await runner.advance(subject);
    const saved = await repo.get(subject.id);
    expect(saved?.pipeline?.stages.some((s) => s.id === "r-etl")).toBe(true);
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
    // Carried structurally, not only in the message: the caller offers checking the
    // branch out as a button, and being told a git command is not being able to run it.
    expect(
      report.outcome.kind === "blocked" && report.outcome.branchMismatch,
    ).toMatchObject({ intended: "bug/dealer-mapping", actual: "LIVE_MultiMarket" });
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

describe("declared verification", () => {
  /** A route whose one stage's outcome is decided by a command, not by the agent. */
  const VERIFIED: RouteDefinition = {
    id: "test",
    label: "Test",
    description: "d",
    stages: [
      {
        id: "build",
        label: "Build",
        kind: "implementation",
        intent: "Build it.",
        splittable: false,
        gate: "auto",
        verify: "dotnet build",
      },
      {
        id: "human-verification",
        label: "Sign off",
        kind: "humanVerification",
        intent: "Check it.",
        splittable: false,
        gate: "approval",
      },
    ],
  };

  const verifiedTask = () => ({
    ...task(),
    pipeline: createPipeline(VERIFIED),
  });

  it("fails a stage whose check fails, however cleanly the agent finished", async () => {
    // The gap this closes: finishSubtask(..., "done") recorded that a session ended
    // without error, not that anything worked.
    const sessions = fakeSessions({ "": { text: "All done, builds cleanly." } });
    const { runner, repo, verified } = makeRunner(sessions, {
      verify: { "dotnet build": { exitCode: 1, output: "CS1002: ; expected" } },
    });
    const subject = verifiedTask();
    await repo.save(subject);

    const report = await runner.advance(subject);

    expect(verified).toEqual(["dotnet build"]);
    expect(report.outcome.kind).toBe("blocked");
    const saved = await repo.get(subject.id);
    const build = saved?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.status).toBe("failed");
    expect(build?.subtasks[0].failureReason).toContain("CS1002");
  });

  describe("discarding declared local paths", () => {
    it("discards before the check reads the tree, not after", async () => {
      // The whole feature. A real task was failed by this check with its work committed
      // and pushed, because the tree held a transformed Web.config and eight tracked
      // build artifacts rewritten with the other line ending. Discarding after the check
      // has already read the tree fixes nothing at all.
      const sessions = fakeSessions({ "": { text: "Done." } });
      const { runner, repo, events } = makeRunner(sessions, {
        verify: { "dotnet build": { exitCode: 0 } },
        discard: { discard: ["QubeAutoApp/Web.config"], withheld: [] },
      });
      const subject = verifiedTask();
      await repo.save(subject);

      await runner.advance(subject);

      expect(events).toEqual(["discard", "verify:dotnet build"]);
    });

    it("announces what it discarded in the stage's own record", async () => {
      // This is the one thing here that destroys work rather than reporting on it, and
      // Web.config does take real changes. Announced, a wrongly removed change is a line
      // someone can see; silent, it is indistinguishable from one never made.
      const sessions = fakeSessions({ "": { text: "Done." } });
      const { runner, repo } = makeRunner(sessions, {
        verify: { "dotnet build": { exitCode: 0, output: "Build succeeded" } },
        discard: { discard: ["QubeAutoApp/Web.config"], withheld: [] },
      });
      const subject = verifiedTask();
      await repo.save(subject);

      const report = await runner.advance(subject);

      expect(report.steps.join(" ")).toContain("Discarded 1 local change(s)");
      const saved = await repo.get(subject.id);
      const build = saved?.pipeline?.stages.find((s) => s.id === "build");
      const recorded = JSON.stringify(build?.subtasks[0].activity ?? {});
      expect(recorded).toContain("QubeAutoApp/Web.config");
      // The check's own output survives alongside it.
      expect(recorded).toContain("Build succeeded");
    });

    it("says nothing when the project declared no paths", async () => {
      // No config means the old behaviour exactly, down to the report.
      const sessions = fakeSessions({ "": { text: "Done." } });
      const { runner, repo, events } = makeRunner(sessions, {
        verify: { "dotnet build": { exitCode: 0 } },
      });
      const subject = verifiedTask();
      await repo.save(subject);

      const report = await runner.advance(subject);

      expect(events).toEqual(["verify:dotnet build"]);
      expect(report.steps.join(" ")).not.toContain("Discarded");
    });

    it("still fails the check when a declared path was withheld", async () => {
      // An untracked or staged path is never discarded, so it is still dirty and the
      // check still fails on it. Saying why is the only thing that stops the operator
      // concluding the feature is broken.
      const sessions = fakeSessions({ "": { text: "Done." } });
      const withheld: DiscardSelection = {
        discard: [],
        withheld: [{ path: "QubeAutoApp/Web.config", reason: "staged, so the change was deliberate" }],
      };
      const { runner, repo } = makeRunner(sessions, {
        verify: { "dotnet build": { exitCode: 1, output: "1 uncommitted change(s)" } },
        discard: withheld,
      });
      const subject = verifiedTask();
      await repo.save(subject);

      const report = await runner.advance(subject);

      expect(report.steps.join(" ")).toContain("Kept QubeAutoApp/Web.config");
      const saved = await repo.get(subject.id);
      expect(saved?.pipeline?.stages.find((s) => s.id === "build")?.status).toBe("failed");
    });
  });

  it("passes a stage whose check passes", async () => {
    const sessions = fakeSessions({ "": { text: "Done." } });
    const { runner, repo, verified } = makeRunner(sessions, {
      verify: { "dotnet build": { exitCode: 0, output: "Build succeeded" } },
    });
    const subject = verifiedTask();
    await repo.save(subject);

    await runner.advance(subject);

    expect(verified).toEqual(["dotnet build"]);
    const saved = await repo.get(subject.id);
    expect(saved?.pipeline?.stages.find((s) => s.id === "build")?.status).toBe("passed");
  });

  it("records that the check actually ran, so a declaration is not mistaken for evidence", async () => {
    // Without this, `verify` set and nothing executed reads exactly like a green
    // build: the runner may have been built with no verifier at all.
    const sessions = fakeSessions({ "": { text: "Done." } });
    const { runner, repo } = makeRunner(sessions, {
      verify: { "dotnet build": { exitCode: 0 } },
    });
    const subject = verifiedTask();
    await repo.save(subject);

    await runner.advance(subject);

    const saved = await repo.get(subject.id);
    const build = saved?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.verification?.command).toBe("dotnet build");
    expect(build?.verification?.exitCode).toBe(0);
  });

  it("records the command and its output where the stage's work is recorded", async () => {
    // A stage that failed verification is exactly the one whose output is wanted.
    const sessions = fakeSessions({ "": { text: "Done." } });
    const { runner, repo } = makeRunner(sessions, {
      verify: { "dotnet build": { exitCode: 1, output: "CS1002" } },
    });
    const subject = verifiedTask();
    await repo.save(subject);

    await runner.advance(subject);

    const saved = await repo.get(subject.id);
    const activity = saved?.pipeline?.stages.find((s) => s.id === "build")?.subtasks[0]
      .activity;
    expect(activity?.commands).toContain("dotnet build");
    expect(activity?.output).toContain("CS1002");
  });

  it("fails the stage when the command cannot run at all", async () => {
    // Nothing verified it, so it must not pass — but the fault is the command's.
    const sessions = fakeSessions({ "": { text: "Done." } });
    const { runner, repo } = makeRunner(sessions, {
      verify: { "dotnet build": { exitCode: -1, spawnError: "spawn ENOENT" } },
    });
    const subject = verifiedTask();
    await repo.save(subject);

    await runner.advance(subject);

    const saved = await repo.get(subject.id);
    const build = saved?.pipeline?.stages.find((s) => s.id === "build");
    expect(build?.status).toBe("failed");
    expect(build?.subtasks[0].failureReason).toContain("could not be started");
  });

  it("does not verify a stage the agent already failed", async () => {
    // There is nothing to certify, and running a build over a stage that never
    // finished wastes minutes to learn what is already known.
    const sessions = fakeSessions({ "": { ok: false, text: "" } });
    const { runner, repo, verified } = makeRunner(sessions, {
      verify: { "dotnet build": { exitCode: 0 } },
    });
    const subject = verifiedTask();
    await repo.save(subject);

    await runner.advance(subject);
    expect(verified).toEqual([]);
  });

  it("does nothing for a stage that declares no check", async () => {
    const sessions = fakeSessions({ "": { text: "Done." } });
    const { runner, repo, verified } = makeRunner(sessions, { verify: {} });
    const subject = task();
    await repo.save(subject);

    await runner.advance(subject);
    expect(verified).toEqual([]);
  });
});

/**
 * A stage that executes a written plan must account for every numbered step.
 *
 * The failure being closed: a deployment stage shipped a migration, a flag and the
 * procedures, silently did not do step 4 — a post-deploy data rebuild — and passed.
 * It surfaced in production as a scorecard tile reading 0.0%.
 */
describe("plan-step accounting", () => {
  const PLANNED: RouteDefinition = {
    id: "planned",
    label: "Planned",
    description: "d",
    stages: [
      {
        id: "deploy",
        label: "Deploy",
        kind: "deployment",
        intent: "Execute the plan.",
        splittable: false,
        gate: "auto",
        planFile: "docs/plan.md",
      },
      {
        id: "ship",
        label: "Ship to live",
        kind: "deployment",
        intent: "Publish.",
        splittable: false,
        gate: "auto",
      },
      {
        id: "human-verification",
        label: "Sign off",
        kind: "humanVerification",
        intent: "Check it.",
        splittable: false,
        gate: "approval",
      },
    ],
  };

  const PLAN = ["## 1. Ship the migration", "## 2. Flip the flag", "## 3. Rebuild the KPI elements"].join(
    "\n",
  );

  const plannedTask = () => ({ ...task(), pipeline: createPipeline(PLANNED) });

  it("tells the stage which steps it must account for", async () => {
    const sessions = fakeSessions({
      "deploy:": { text: "STEP 1: done — ran it\nSTEP 2: done — on\nSTEP 3: done — rebuilt" },
    });
    const { runner, repo } = makeRunner(sessions, { files: { "docs/plan.md": PLAN } });
    const subject = plannedTask();
    await repo.save(subject);

    await runner.advance(subject);

    const prompt = sessions.calls.find((c) => c.label.startsWith("deploy:"))!.prompt;
    expect(prompt).toContain("docs/plan.md");
    expect(prompt).toContain("3. Rebuild the KPI elements");
  });

  it("records each step's account and passes a stage that accounted for all of them", async () => {
    const sessions = fakeSessions({
      "deploy:": {
        text: "Deployed.\nSTEP 1: done — ran it\nSTEP 2: done — flag on\nSTEP 3: done — rebuilt 29/30",
      },
    });
    const { runner, repo } = makeRunner(sessions, { files: { "docs/plan.md": PLAN } });
    const subject = plannedTask();
    await repo.save(subject);

    await runner.advance(subject);

    const stage = (await repo.get(subject.id))?.pipeline?.stages.find((s) => s.id === "deploy");
    expect(stage?.status).toBe("passed");
    expect(stage?.planSteps?.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(stage?.planSteps?.[2].note).toBe("rebuilt 29/30");
  });

  it("holds the stage when it says nothing about a step", async () => {
    // The whole mechanism: silence about step 3 is what reached production, and it
    // reads identically to having done it.
    const sessions = fakeSessions({
      "deploy:": { text: "Deployed.\nSTEP 1: done — ran it\nSTEP 2: done — flag on" },
    });
    const { runner, repo } = makeRunner(sessions, { files: { "docs/plan.md": PLAN } });
    const subject = plannedTask();
    await repo.save(subject);

    const report = await runner.advance(subject);

    expect(report.outcome).toMatchObject({ kind: "awaitingApproval", stageId: "deploy" });
    const stage = (await repo.get(subject.id))?.pipeline?.stages.find((s) => s.id === "deploy");
    expect(stage?.status).toBe("awaiting-approval");
    expect(stage?.planSteps?.find((s) => s.number === 3)?.status).toBe("unaccounted");
    expect(report.steps.join(" ")).toContain("unaccounted for");
  });

  it("turns a step reported not done into a deferral, so a stage that ships holds", async () => {
    const sessions = fakeSessions({
      "deploy:": {
        text: [
          "Deployed.",
          "STEP 1: done — ran it",
          "STEP 2: done — flag on",
          "STEP 3: not done — changes live data and needs a human to authorise it",
        ].join("\n"),
      },
    });
    const { runner, repo } = makeRunner(sessions, { files: { "docs/plan.md": PLAN } });
    const subject = plannedTask();
    await repo.save(subject);

    const report = await runner.advance(subject);

    // The stage itself passes — a step reported not done is a correct answer — and the
    // route then holds in front of the next stage that ships.
    expect(report.outcome).toMatchObject({ kind: "deferredWork", stageId: "ship" });
    const saved = await repo.get(subject.id);
    expect(saved?.pipeline?.stages.find((s) => s.id === "deploy")?.status).toBe("passed");
    const deferral = saved?.pipeline?.deferrals?.[0];
    expect(deferral?.text).toContain("Plan step 3");
    expect(deferral?.text).toContain("needs a human to authorise it");
  });

  it("will not run a stage whose plan file is missing", async () => {
    // Running it anyway means improvising from the brief and reporting done, which is
    // the state per-step accounting exists to make impossible.
    const sessions = fakeSessions({ "deploy:": { text: "Deployed everything." } });
    const { runner, repo } = makeRunner(sessions, { files: {} });
    const subject = plannedTask();
    await repo.save(subject);

    const report = await runner.advance(subject);

    expect(report.outcome).toMatchObject({ kind: "blocked", stageId: "deploy" });
    expect(sessions.calls).toEqual([]);
    const stage = (await repo.get(subject.id))?.pipeline?.stages.find((s) => s.id === "deploy");
    expect(stage?.blocked).toContain("does not exist");
  });

  it("runs a stage with a plan file normally when no file reader is wired", async () => {
    // A headless run built without the reader must behave exactly as it did before.
    const sessions = fakeSessions({ "deploy:": { text: "Deployed." } });
    const { runner, repo } = makeRunner(sessions);
    const subject = plannedTask();
    await repo.save(subject);

    await runner.advance(subject);
    const stage = (await repo.get(subject.id))?.pipeline?.stages.find((s) => s.id === "deploy");
    expect(stage?.status).toBe("passed");
    expect(stage?.planSteps).toBeUndefined();
  });
});

describe("verification command substitution", () => {
  const SUBSTITUTED: RouteDefinition = {
    id: "sub",
    label: "Sub",
    description: "d",
    stages: [
      {
        id: "build",
        label: "Build",
        kind: "implementation",
        intent: "Build it.",
        splittable: false,
        gate: "auto",
        verify: 'check.ps1 -Ticket "${taskName}" -Branch ${branch} -Base ${baseBranch}',
      },
    ],
  };

  it("substitutes the task's own facts into the command that runs", async () => {
    // Without this a check written once for a route cannot know which ticket it is
    // certifying, and a script meant to reject another ticket's worktree degrades into
    // an existence check that passes in exactly the case that matters.
    const command =
      'check.ps1 -Ticket "Fix dealer mapping" -Branch bug/dealer-mapping -Base main';
    const sessions = fakeSessions({ "": { text: "Done." } });
    const { runner, repo, verified } = makeRunner(sessions, {
      verify: { [command]: { exitCode: 0 } },
    });
    const subject = { ...task(), pipeline: createPipeline(SUBSTITUTED) };
    await repo.save(subject);

    await runner.advance(subject);

    expect(verified).toEqual([command]);
    const stage = (await repo.get(subject.id))?.pipeline?.stages[0];
    expect(stage?.status).toBe("passed");
  });

  it("reports the substituted command in the failure, not the declared one", async () => {
    // The declared form would send a reader to run something different by hand.
    const command =
      'check.ps1 -Ticket "Fix dealer mapping" -Branch bug/dealer-mapping -Base main';
    const sessions = fakeSessions({ "": { text: "Done." } });
    const { runner, repo } = makeRunner(sessions, {
      verify: { [command]: { exitCode: 3, output: "worktree is on another ticket" } },
    });
    const subject = { ...task(), pipeline: createPipeline(SUBSTITUTED) };
    await repo.save(subject);

    await runner.advance(subject);

    const stage = (await repo.get(subject.id))?.pipeline?.stages[0];
    expect(stage?.status).toBe("failed");
    expect(stage?.subtasks[0].failureReason).toContain("Fix dealer mapping");
    expect(stage?.subtasks[0].activity?.commands).toEqual([command]);
  });
});

describe("worktree claims", () => {
  const MOVER: RouteDefinition = {
    id: "mover",
    label: "Mover",
    description: "d",
    stages: [
      {
        id: "promote",
        label: "Promote to UAT",
        kind: "deployment",
        intent: "Cherry-pick into the promotion tree.",
        splittable: false,
        gate: "auto",
        mayChangeBranch: true,
      },
    ],
  };

  /** A claim service whose git reports one extra worktree after the stage runs. */
  function claimService(
    repo: InMemoryTaskRepository,
    lists: { path: string; branch?: string }[][],
  ) {
    const queue = [...lists];
    return new WorktreeClaimService(
      {
        async list() {
          return queue.length > 1 ? queue.shift() : queue[0];
        },
        async isDirty() {
          return false;
        },
        async countUnmerged() {
          return 0;
        },
        async remove() {
          return undefined;
        },
      },
      repo,
      logger,
    );
  }

  function moverRunner(
    sessions: StageSessionRunner,
    lists: { path: string; branch?: string }[][],
  ) {
    const repo = new InMemoryTaskRepository();
    const changed: ChangedPathsSource = { getChangedPaths: async () => ok([]) };
    const plans = new ReviewPlanService(changed, repo, logger, () => ({
      rules: [],
      problems: [],
      noRulesConfigured: true,
    }));
    return {
      repo,
      runner: new PipelineRunner(
        sessions,
        repo,
        plans,
        logger,
        () => undefined,
        undefined,
        () => true,
        () => undefined,
        undefined,
        undefined,
        undefined,
        claimService(repo, lists),
      ),
    };
  }

  it("records a worktree the stage created against the task", async () => {
    // The stage makes it with `git worktree add`, not the extension, so the only way to
    // know is that it was not in the list before the stage ran.
    const sessions = fakeSessions({ "": { text: "Cherry-picked and pushed." } });
    const { runner, repo } = moverRunner(sessions, [
      [{ path: "C:/repos/app-t1", branch: "bug/dealer-mapping" }],
      [
        { path: "C:/repos/app-t1", branch: "bug/dealer-mapping" },
        { path: "C:/repos/promote-uat", branch: "promote/t1-uat" },
      ],
    ]);
    const subject = { ...task(), pipeline: createPipeline(MOVER) };
    await repo.save(subject);

    await runner.advance(subject);

    const saved = await repo.get(subject.id);
    expect(saved?.worktreeClaims).toEqual([
      {
        path: "C:/repos/promote-uat",
        branch: "promote/t1-uat",
        claimedAt: expect.any(String),
        created: true,
        stageId: "promote",
      },
    ]);
    // The pipeline outcome must survive the claim being written: both are saved through
    // the same read-modify-write state file.
    expect(saved?.pipeline?.stages[0].status).toBe("passed");
  });

  it("holds the stage when the worktree belongs to another task", async () => {
    // Two tasks promoting through one tree interleave their cherry-picks. The previous
    // warning was an agent noticing it in `git worktree list` and saying so in prose.
    const sessions = fakeSessions({ "": { text: "Cherry-picked." } });
    const { runner, repo } = moverRunner(sessions, [
      [{ path: "C:/repos/app-t1" }],
      [{ path: "C:/repos/app-t1" }, { path: "C:/repos/qube-publish-sm", branch: "live" }],
    ]);
    const subject = { ...task(), pipeline: createPipeline(MOVER) };
    await repo.save(subject);
    await repo.save({
      ...task(),
      id: "t2",
      name: "NMGB-2801",
      worktreePath: "C:/repos/app-t2",
      pipeline: undefined,
      worktreeClaims: [
        { path: "C:/repos/qube-publish-sm", branch: "live", claimedAt: "t", created: false },
      ],
    });

    const report = await runner.advance(subject);

    expect(report.outcome).toMatchObject({ kind: "awaitingApproval", stageId: "promote" });
    const stage = (await repo.get(subject.id))?.pipeline?.stages[0];
    expect(stage?.status).toBe("awaiting-approval");
    expect(stage?.blocked).toContain("NMGB-2801");
    expect((await repo.get(subject.id))?.worktreeClaims ?? []).toEqual([]);
  });

  // The bug this closes: the claim was recorded only on the path that interpreted the
  // reply, and a promotion stage is the likeliest of all stages to leave by another —
  // asking a question, being stopped, or having a push refused is routine for one. The
  // worktrees exist the moment the session ends, however the reply is later read, and
  // an unrecorded one is attached to nothing: never cleaned up, and listed forever as
  // an orphan the harness itself created.
  it("records a worktree even when the stage ends by asking a question", async () => {
    const sessions = fakeSessions({
      "": { text: "NEEDS-INFO:\n1. Which environment should this promote to?" },
    });
    const { runner, repo } = moverRunner(sessions, [
      [{ path: "C:/repos/app-t1", branch: "bug/dealer-mapping" }],
      [
        { path: "C:/repos/app-t1", branch: "bug/dealer-mapping" },
        { path: "C:/repos/promote-uat", branch: "promote/t1-uat" },
      ],
    ]);
    const subject = { ...task(), pipeline: createPipeline(MOVER) };
    await repo.save(subject);

    const report = await runner.advance(subject);

    expect(report.outcome.kind).toBe("needsInput");
    const saved = await repo.get(subject.id);
    expect((saved?.worktreeClaims ?? []).map((c) => c.path)).toEqual([
      "C:/repos/promote-uat",
    ]);
  });

  it("records a worktree even when the stage is stopped mid-run", async () => {
    // Aborted from inside the session, which is what stopping an agent actually does:
    // the worktree already exists by then, and the run leaves by the cancel path.
    const controller = new AbortController();
    const sessions: StageSessionRunner = {
      async run() {
        controller.abort();
        return { ok: true, text: "Cherry-picked." };
      },
    };
    const { runner, repo } = moverRunner(sessions, [
      [{ path: "C:/repos/app-t1", branch: "bug/dealer-mapping" }],
      [
        { path: "C:/repos/app-t1", branch: "bug/dealer-mapping" },
        { path: "C:/repos/promote-uat", branch: "promote/t1-uat" },
      ],
    ]);
    const subject = { ...task(), pipeline: createPipeline(MOVER) };
    await repo.save(subject);

    const report = await runner.advance(subject, controller.signal);

    expect(report.outcome.kind).toBe("cancelled");
    const saved = await repo.get(subject.id);
    expect((saved?.worktreeClaims ?? []).map((c) => c.path)).toEqual([
      "C:/repos/promote-uat",
    ]);
  });

  it("does not ask git about a stage that cannot move the worktree", async () => {
    // A list per subtask of every stage is a process launch to learn nothing.
    let listed = 0;
    const repo = new InMemoryTaskRepository();
    const changed: ChangedPathsSource = { getChangedPaths: async () => ok([]) };
    const plans = new ReviewPlanService(changed, repo, logger, () => ({
      rules: [],
      problems: [],
      noRulesConfigured: true,
    }));
    const claims = new WorktreeClaimService(
      {
        async list() {
          listed += 1;
          return [];
        },
        async isDirty() {
          return false;
        },
        async countUnmerged() {
          return 0;
        },
        async remove() {
          return undefined;
        },
      },
      repo,
      logger,
    );
    const runner = new PipelineRunner(
      fakeSessions({ "plan:": { text: PLAN_REPLY } }),
      repo,
      plans,
      logger,
      () => undefined,
      undefined,
      () => true,
      () => undefined,
      undefined,
      undefined,
      undefined,
      claims,
    );
    const subject = task();
    await repo.save(subject);

    await runner.advance(subject);
    expect(listed).toBe(0);
  });
});

/**
 * A correction that says it is the wrong tool for the job.
 *
 * The bug: `correctionPrompt` told the session to stop and say so if the finding
 * needed a change of approach, and gave it nothing to say it with. So the reply came
 * back as prose, the session had not errored, the subtask was recorded "done", the
 * stage settled and the route advanced — building every later stage on output the
 * correction had just confirmed was wrong. On a real task that was a grid rebuilt from
 * the wrong wireframe tab, with the fix reported as applied.
 */
describe("a correction the stage declines", () => {
  const oneStageRoute = (): RouteDefinition => ({
    ...ROUTE,
    stages: [
      {
        id: "build",
        label: "Build",
        kind: "implementation",
        intent: "Build it.",
        splittable: false,
        gate: "auto",
      },
    ],
  });

  const DECLINE = [
    "The mock-up's tab 3 is one row per code with the metrics as columns, not the",
    "stacked RowOrder shape that was built.",
    "",
    "CORRECTION-DECLINED: the stored procedure must return metrics as columns, which",
    "re-opens the proc, the helper and the grid column definitions",
  ].join("\n");

  /** Runs the stage, then appends a correction to it, and returns the repository. */
  async function corrected(fixReply: { ok?: boolean; text: string }) {
    const repo = new InMemoryTaskRepository();
    const { runner } = makeRunner(fakeSessions({ "build:": { text: "Built it." } }), {
      repo,
    });
    await repo.save({ ...task(), pipeline: createPipeline(oneStageRoute()) });
    await runner.advance((await repo.get("t1"))!);

    const before = (await repo.get("t1"))!;
    const fixed = correctStage(before.pipeline!, "build", {
      finding: "The layout was copied from Phase 2.",
      at: "2026-08-10T09:00:00.000Z",
    });
    if (!fixed.ok) throw new Error(fixed.error.message);
    await repo.save({ ...before, pipeline: fixed.value });

    // The fix key first: `fakeSessions` matches on the first registered prefix, and
    // "build:" would otherwise swallow the correction's own label.
    const { runner: second } = makeRunner(
      fakeSessions({ "build:build-fix": fixReply, "build:": { text: "Built it." } }),
      { repo },
    );
    const report = await second.advance((await repo.get("t1"))!);
    return { repo, report };
  }

  it("holds the stage instead of recording it as fixed", async () => {
    const { repo } = await corrected({ text: DECLINE });

    const stage = (await repo.get("t1"))!.pipeline!.stages[0];
    // "passed" is what it used to be, which is the whole defect: nothing changed and
    // the route said the finding had been dealt with.
    expect(stage.status).toBe("awaiting-approval");
  });

  it("says the remedy is a re-run, not just that it stopped", async () => {
    // A held stage with no remedy leaves the operator where the bug left them:
    // reading prose to work out what the harness wants them to do next.
    const { repo, report } = await corrected({ text: DECLINE });

    const stage = (await repo.get("t1"))!.pipeline!.stages[0];
    expect(stage.blocked).toContain("re-run");
    expect(stage.blocked).toContain("metrics as columns");
    expect(report.steps.join(" ")).toContain("declined the correction");
  });

  it("keeps the marker out of the reply the report shows", async () => {
    const { repo } = await corrected({ text: DECLINE });

    const fix = (await repo.get("t1"))!.pipeline!.stages[0].subtasks.find(
      (s) => s.correction,
    );
    expect(fix?.reply).toContain("one row per code");
    expect(fix?.reply).not.toContain("CORRECTION-DECLINED:");
  });

  it("passes a correction that actually made the change", async () => {
    const { repo } = await corrected({ text: "Changed the cast to decimal." });

    expect((await repo.get("t1"))!.pipeline!.stages[0].status).toBe("passed");
  });

  it("ignores the line on a subtask that is not a correction", async () => {
    // An ordinary run has no correction to decline, so the marker there is a model
    // quoting the protocol rather than using it. Holding on that would make this
    // marker's first visible effect a route stopped for no reason.
    const repo = new InMemoryTaskRepository();
    const { runner } = makeRunner(fakeSessions({ "build:": { text: DECLINE } }), { repo });
    await repo.save({ ...task(), pipeline: createPipeline(oneStageRoute()) });
    await runner.advance((await repo.get("t1"))!);

    expect((await repo.get("t1"))!.pipeline!.stages[0].status).toBe("passed");
  });
});

/**
 * A stage that investigated and reported, without changing anything.
 *
 * The sixth instance of one disease, and the first caught without the reply's help. The
 * stage traced a scorecard defect to the aggregation grain of a shared core proc,
 * concluded the fix was a product decision out of scope for its route, wrote "Why I
 * stopped" in prose, and passed. The route advanced onto stages assuming a fix that did
 * not exist.
 */
describe("an implementation stage that wrote no files", () => {
  const implRoute = (): RouteDefinition => ({
    ...ROUTE,
    stages: [
      {
        id: "build",
        label: "Build",
        kind: "implementation",
        intent: "Fix the defect.",
        splittable: false,
        gate: "auto",
      },
    ],
  });

  /** A session that reads and runs commands but writes nothing. */
  const investigating = (text: string): StageSessionRunner => ({
    async run() {
      return {
        ok: true,
        text,
        activity: { toolCounts: { Read: 8, Bash: 4 }, commands: ["sqlcmd -Q \"select 1\""] },
      };
    },
  });

  const REPORT =
    "Root cause: the proc filters #AllDealers by the calling link type.\n" +
    "Why I stopped: fixing it changes aggregation grain on a shared core proc, " +
    "which is out of scope for this route and is a product decision.";

  it("holds instead of passing, without needing a marker", () => {
    // The whole point: every other defence depends on the stage saying so.
    const repo = new InMemoryTaskRepository();
    const { runner } = makeRunner(investigating(REPORT), { repo });
    return (async () => {
      await repo.save({ ...task(), pipeline: createPipeline(implRoute()) });
      await runner.advance((await repo.get("t1"))!);

      const stage = (await repo.get("t1"))!.pipeline!.stages[0];
      expect(stage.status).toBe("awaiting-approval");
      expect(stage.blocked).toContain("changed no files");
    })();
  });

  it("passes a stage that wrote something", async () => {
    const writing: StageSessionRunner = {
      async run() {
        return { ok: true, text: "Fixed it.", activity: { pathsWritten: ["src/a.cs"] } };
      },
    };
    const repo = new InMemoryTaskRepository();
    const { runner } = makeRunner(writing, { repo });
    await repo.save({ ...task(), pipeline: createPipeline(implRoute()) });
    await runner.advance((await repo.get("t1"))!);

    expect((await repo.get("t1"))!.pipeline!.stages[0].status).toBe("passed");
  });
});

/**
 * A host that dies mid-subtask takes the session listener, the per-subtask timeout
 * and the driver awaiting the run with it, leaving the record `active` with no
 * reply, no activity and no cost. Nothing detected that: the route was not running,
 * so no advance was there to reclaim it, and Stop wrote nothing at all. One sat
 * `active` for two hours after its session had finished.
 */
describe("reclaimStale", () => {
  /** A task wedged mid-subtask, as a dead host leaves it in the state file. */
  function wedged(startedAt: string): TaskWorkspace {
    const t = task();
    const stage = t.pipeline!.stages[0];
    stage.status = "active";
    stage.subtasks = [
      {
        id: "build-1",
        title: "Build it",
        prompt: "Build it.",
        status: "active",
        startedAt,
      },
    ];
    return t;
  }

  it("puts back an active subtask no live run owns", async () => {
    const { repo, runner } = makeRunner(fakeSessions());
    await repo.save(wedged("2026-08-12T09:08:36.485Z"));

    const outcome = await runner.reclaimStale(
      (await repo.get("t1"))!,
      "2026-08-12T11:00:00.000Z",
    );

    expect(outcome.reclaimed.map((r) => r.subtaskId)).toEqual(["build-1"]);
    const saved = (await repo.get("t1"))!.pipeline!.stages[0];
    expect(saved.subtasks[0].status).toBe("pending");
    expect(saved.subtasks[0].startedAt).toBeUndefined();
    // Reverted, not failed: the stage has not been judged, so the route must
    // resume from it rather than skip past it.
    expect(saved.status).toBe("pending");
  });

  // The state file is shared by every worktree of a repository, so an unowned
  // active subtask may belong to another window that started it moments ago.
  it("leaves a young one alone", async () => {
    const { repo, runner } = makeRunner(fakeSessions());
    await repo.save(wedged("2026-08-12T10:55:00.000Z"));

    const outcome = await runner.reclaimStale(
      (await repo.get("t1"))!,
      "2026-08-12T11:00:00.000Z",
    );

    expect(outcome.reclaimed).toEqual([]);
    expect((await repo.get("t1"))!.pipeline!.stages[0].subtasks[0].status).toBe("active");
  });

  it("leaves a subtask this host is running alone, however old", async () => {
    // Held open so the subtask is genuinely in flight while the sweep runs.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions: StageSessionRunner = {
      run: async () => {
        await held;
        return { ok: true, text: "done" };
      },
    };
    const { repo, runner } = makeRunner(sessions, { staleAfterMs: 0 });
    await repo.save(task());

    const advancing = runner.advance((await repo.get("t1"))!);
    // Let the driver reach the session and mark the subtask active.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outcome = await runner.reclaimStale(
      (await repo.get("t1"))!,
      "2026-08-12T11:00:00.000Z",
    );

    expect(outcome.reclaimed).toEqual([]);
    release();
    await advancing;
  });

  it("reports nothing for a task with no pipeline", async () => {
    const { repo, runner } = makeRunner(fakeSessions());
    const t = { ...task(), pipeline: undefined };
    await repo.save(t);

    const outcome = await runner.reclaimStale(t, "2026-08-12T11:00:00.000Z");

    expect(outcome.reclaimed).toEqual([]);
  });

  it("makes the reclaimed subtask runnable again", async () => {
    const sessions = fakeSessions({ "plan:": { text: PLAN_REPLY } });
    const { repo, runner } = makeRunner(sessions);
    await repo.save(wedged("2026-08-12T09:08:36.485Z"));

    await runner.reclaimStale((await repo.get("t1"))!, "2026-08-12T11:00:00.000Z");
    await runner.advance((await repo.get("t1"))!);

    // The point of the reclaim: the route resumes from the stage rather than
    // reporting a subtask already in flight and blocking forever.
    expect(sessions.calls.length).toBeGreaterThan(0);
  });
});
