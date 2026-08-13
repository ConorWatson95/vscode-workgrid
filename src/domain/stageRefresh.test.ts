import { describe, expect, it } from "vitest";
import {
  guidanceFor,
  refreshPendingStages,
  addMissingStages,
  revertToStage,
  sendBackTargets,
  sendBackToStage,
  repositionRuleStages,
  repositionRouteStages,
  syncHandoffs,
} from "./stageRefresh";
import { TaskPipeline, TaskStage } from "./taskPipeline";
import { RouteDefinition } from "./taskRoute";
import { ReviewRule } from "./reviewRules";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "deploy",
    name: "Deploy",
    kind: "implement",
    status: "pending",
    intent: "Run the deployment.",
    splittable: false,
    requiresApproval: false,
    subtasks: [
      {
        id: "deploy-1",
        title: "Deploy",
        prompt: "Run the deployment.",
        status: "pending",
      },
    ],
    ...overrides,
  } as TaskStage;
}

function pipeline(stages: TaskStage[]): TaskPipeline {
  return { routeId: "sql-change", stages };
}

const route = (
  stages: Array<{ id: string; intent: string; model?: string }>,
): RouteDefinition =>
  ({
    id: "sql-change",
    label: "SQL change",
    description: "",
    stages: stages.map((s) => ({
      id: s.id,
      label: s.id,
      kind: "implement",
      intent: s.intent,
      model: s.model,
      gate: "approval",
    })),
  }) as RouteDefinition;

const source = (
  stages: Array<{ id: string; intent: string; model?: string }>,
  rules: ReviewRule[] = [],
) => ({ routes: [route(stages)], rules });

describe("addMissingStages", () => {
  const DEV_PROMOTE = {
    id: "dev-promote",
    label: "Land on DEV",
    kind: "implement",
    intent: "Commit, push and merge.",
    splittable: false,
    gate: "auto",
    verify: "git merge-base --is-ancestor HEAD origin/DEV",
  } as unknown as RouteDefinition["stages"][number];

  /** A route whose stage list has DEV_PROMOTE spliced in at `at`. */
  const grownRoute = (at: number): RouteDefinition => {
    const base = route([
      { id: "deploy", intent: "Run the deployment." },
      { id: "signoff", intent: "Sign it off." },
    ]);
    const stages = [...base.stages];
    stages.splice(at, 0, DEV_PROMOTE);
    return { ...base, stages };
  };

  const twoStagePipeline = (firstStatus: TaskStage["status"] = "pending") =>
    pipeline([
      stage({ id: "deploy", status: firstStatus }),
      stage({ id: "signoff", name: "Signoff" }),
    ]);

  it("adds a stage the route gained, in the route's position", () => {
    const result = addMissingStages(twoStagePipeline(), {
      routes: [grownRoute(1)],
      rules: [],
    });
    expect(result.added).toEqual(["dev-promote"]);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "deploy",
      "dev-promote",
      "signoff",
    ]);
  });

  it("carries the definition's verify onto the new stage", () => {
    // The whole reason for adding it: an unverified stage is the thing being fixed.
    const result = addMissingStages(twoStagePipeline(), {
      routes: [grownRoute(1)],
      rules: [],
    });
    const added = result.pipeline.stages.find((s) => s.id === "dev-promote");
    expect(added?.verify).toBe("git merge-base --is-ancestor HEAD origin/DEV");
    expect(added?.status).toBe("pending");
  });

  it("refuses to insert behind a stage that already ran", () => {
    // Otherwise the route would claim to have run a step it never ran, which is the
    // failure this whole area exists to prevent.
    const before = twoStagePipeline("passed");
    const result = addMissingStages(before, { routes: [grownRoute(0)], rules: [] });
    expect(result.added).toEqual([]);
    expect(result.tooLate).toEqual(["dev-promote"]);
    expect(result.pipeline).toBe(before);
  });

  it("still adds a stage that belongs ahead of the frontier", () => {
    const result = addMissingStages(twoStagePipeline("passed"), {
      routes: [grownRoute(1)],
      rules: [],
    });
    expect(result.added).toEqual(["dev-promote"]);
    expect(result.tooLate).toEqual([]);
  });

  it("never removes a stage the route no longer defines", () => {
    const result = addMissingStages(twoStagePipeline(), {
      routes: [route([{ id: "deploy", intent: "Run the deployment." }])],
      rules: [],
    });
    expect(result.pipeline.stages.map((s) => s.id)).toEqual(["deploy", "signoff"]);
  });

  it("returns the same pipeline when the route matches", () => {
    const before = twoStagePipeline();
    const result = addMissingStages(before, {
      routes: [
        route([
          { id: "deploy", intent: "Run the deployment." },
          { id: "signoff", intent: "Sign it off." },
        ]),
      ],
      rules: [],
    });
    expect(result.pipeline).toBe(before);
    expect(result.added).toEqual([]);
  });

  it("does nothing when the route is not in config at all", () => {
    const before = twoStagePipeline();
    const result = addMissingStages(before, { routes: [], rules: [] });
    expect(result.pipeline).toBe(before);
  });
});

describe("repositionRouteStages", () => {
  /** The real case: SQL deploy, local verify, merge — a route that reordered them. */
  const CORRECTED = source([
    { id: "commit", intent: "Commit and push the branch." },
    { id: "deploy-sql", intent: "Deploy the SQL to DEV." },
    { id: "local-verify", intent: "Verify locally against DEV." },
    { id: "dev-promote", intent: "Merge into shared DEV." },
    { id: "signoff", intent: "Sign it off on the DEV site." },
  ]);

  /** The order an older build of that route left behind. */
  const stale = (statuses: Partial<Record<string, TaskStage["status"]>> = {}) =>
    pipeline(
      ["commit", "dev-promote", "deploy-sql", "local-verify", "signoff"].map((id) =>
        stage({ id, name: id, status: statuses[id] ?? "pending" }),
      ),
    );

  it("puts pending stages back into the order the route now declares", () => {
    const result = repositionRouteStages(stale(), CORRECTED);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "commit",
      "deploy-sql",
      "local-verify",
      "dev-promote",
      "signoff",
    ]);
    expect(result.moved).toEqual(["deploy-sql", "local-verify", "dev-promote"]);
  });

  it("pins a stage that has already run, and never moves one across it", () => {
    // The honest limit: a merge that already happened cannot be put back behind the
    // deploy it should have followed. Reverting is the only repair, and it is a
    // human's call because it discards work.
    const result = repositionRouteStages(
      stale({ commit: "passed", "dev-promote": "passed" }),
      CORRECTED,
    );
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "commit",
      "dev-promote",
      "deploy-sql",
      "local-verify",
      "signoff",
    ]);
    expect(result.moved).toEqual([]);
  });

  it("treats a stage whose subtask has started as having run", () => {
    // Status can still read "pending" while the first subtask is away.
    const before = stale();
    const running = {
      ...before,
      stages: before.stages.map((s) =>
        s.id === "dev-promote"
          ? { ...s, subtasks: s.subtasks.map((t) => ({ ...t, status: "running" as const })) }
          : s,
      ),
    };
    expect(repositionRouteStages(running, CORRECTED).moved).toEqual([]);
  });

  it("leaves a rule-added stage exactly where the rule engine put it", () => {
    // Its position comes from ruleInsertionIndex, not from route order, and the route
    // does not mention it at all.
    const before = pipeline([
      stage({ id: "commit", name: "commit" }),
      stage({ id: "dev-promote", name: "dev-promote" }),
      stage({ id: "sql-review", name: "sql-review", addedByRule: "sql" } as Partial<TaskStage>),
      stage({ id: "deploy-sql", name: "deploy-sql" }),
      stage({ id: "local-verify", name: "local-verify" }),
    ]);
    const result = repositionRouteStages(before, CORRECTED);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "commit",
      "deploy-sql",
      "sql-review",
      "local-verify",
      "dev-promote",
    ]);
    expect(result.moved).not.toContain("sql-review");
  });

  it("leaves a stage the route no longer defines where it is", () => {
    const before = pipeline([
      stage({ id: "dev-promote", name: "dev-promote" }),
      stage({ id: "retired", name: "retired" }),
      stage({ id: "deploy-sql", name: "deploy-sql" }),
    ]);
    const result = repositionRouteStages(before, CORRECTED);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "deploy-sql",
      "retired",
      "dev-promote",
    ]);
  });

  it("returns the same pipeline when the order already matches", () => {
    const before = pipeline(
      ["commit", "deploy-sql", "local-verify", "dev-promote", "signoff"].map((id) =>
        stage({ id, name: id }),
      ),
    );
    const result = repositionRouteStages(before, CORRECTED);
    expect(result.pipeline).toBe(before);
    expect(result.moved).toEqual([]);
  });

  it("does nothing when the route is not in config at all", () => {
    const before = stale();
    expect(repositionRouteStages(before, { routes: [], rules: [] }).pipeline).toBe(before);
  });

  it("never mutates the pipeline it was given", () => {
    const before = stale();
    const order = before.stages.map((s) => s.id);
    repositionRouteStages(before, CORRECTED);
    expect(before.stages.map((s) => s.id)).toEqual(order);
  });
});

describe("refreshPendingStages", () => {
  it("brings a not-yet-started stage's intent up to date", () => {
    // The reported case: a deploy intent that omitted -Project, fixed in config.
    const result = refreshPendingStages(
      pipeline([stage()]),
      source([{ id: "deploy", intent: "Run the deployment with -Project X." }]),
    );
    expect(result.changed).toEqual(["deploy"]);
    expect(result.pipeline.stages[0].intent).toBe("Run the deployment with -Project X.");
  });

  it("updates the subtask prompt derived from that intent", () => {
    // Otherwise the stage carries the new intent but still runs the old prompt.
    const result = refreshPendingStages(
      pipeline([stage()]),
      source([{ id: "deploy", intent: "Run it with -Project X." }]),
    );
    expect(result.pipeline.stages[0].subtasks[0].prompt).toBe("Run it with -Project X.");
  });

  it("leaves a subtask prompt alone when it was not the raw intent", () => {
    // A split stage's prompts were written by an agent, not copied from the intent.
    const split = stage({
      subtasks: [
        { id: "deploy-1", title: "Part one", prompt: "Do part one.", status: "pending" },
      ],
    });
    const result = refreshPendingStages(
      pipeline([split]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.pipeline.stages[0].subtasks[0].prompt).toBe("Do part one.");
  });

  it("does not touch a stage that has already passed", () => {
    // History has to stay truthful: a stage kept the instruction it actually ran.
    const passed = stage({ status: "passed" });
    const result = refreshPendingStages(
      pipeline([passed]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.changed).toEqual([]);
    expect(result.pipeline.stages[0].intent).toBe("Run the deployment.");
  });

  it("does not touch a stage whose subtask is already running", () => {
    const running = stage({
      subtasks: [
        { id: "deploy-1", title: "Deploy", prompt: "Run the deployment.", status: "active" },
      ],
    });
    const result = refreshPendingStages(
      pipeline([running]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.changed).toEqual([]);
  });

  it("keeps what it has when the stage is no longer in config", () => {
    const result = refreshPendingStages(
      pipeline([stage({ id: "retired" })]),
      source([{ id: "deploy", intent: "Changed." }]),
    );
    expect(result.changed).toEqual([]);
    expect(result.pipeline.stages[0].intent).toBe("Run the deployment.");
  });

  it("returns the same pipeline object when nothing differs, so no save is needed", () => {
    const original = pipeline([stage()]);
    const result = refreshPendingStages(
      original,
      source([{ id: "deploy", intent: "Run the deployment." }]),
    );
    expect(result.pipeline).toBe(original);
    expect(result.changed).toEqual([]);
  });

  it("refreshes a rule-added stage from the rules, not the route", () => {
    const rule = {
      id: "r1",
      description: "",
      when: { pathPatterns: ["**/*.sql"] },
      stage: { id: "r-review", label: "r", kind: "review", intent: "New rule intent." },
    } as ReviewRule;
    const result = refreshPendingStages(
      pipeline([stage({ id: "r-review", addedByRule: "r1", intent: "Old." })]),
      source([], [rule]),
    );
    expect(result.pipeline.stages[0].intent).toBe("New rule intent.");
  });

  it("leaves splittable alone, because it decides the stage's shape", () => {
    // Flipping it would reshape the pipeline rather than correct an instruction,
    // and the synthesized subtask a non-splittable stage carries would be wrong.
    const result = refreshPendingStages(
      pipeline([stage({ splittable: false })]),
      {
        routes: [
          {
            ...route([{ id: "deploy", intent: "Run the deployment." }]),
            stages: [
              {
                id: "deploy",
                label: "deploy",
                kind: "implement",
                intent: "Run the deployment.",
                splittable: true,
                gate: "approval",
              },
            ],
          } as RouteDefinition,
        ],
        rules: [],
      },
    );
    expect(result.changed).toEqual([]);
    expect(result.pipeline.stages[0].splittable).toBe(false);
  });

  it("picks up a model change too", () => {
    const result = refreshPendingStages(
      pipeline([stage({ model: "opus" })]),
      source([{ id: "deploy", intent: "Run the deployment.", model: "sonnet" }]),
    );
    expect(result.pipeline.stages[0].model).toBe("sonnet");
  });
});

describe("revertToStage", () => {
  const ran = (id: string, status: TaskStage["status"] = "passed") =>
    stage({
      id,
      status,
      finishedAt: "t1",
      checklist: [
        { id: "c1", text: "check it", checked: true, raisedByStage: id },
      ],
      subtasks: [
        {
          id: `${id}-1`,
          title: id,
          prompt: "p",
          status: "done",
          sessionId: "s1",
          finishedAt: "t1",
          reply: "did it",
          activity: { toolCounts: { Bash: 1 } },
        },
      ],
    });

  it("re-opens the named stage and everything after it", () => {
    // Later stages were built on output being discarded, so leaving them passed
    // would mean approving work that no longer exists.
    const result = revertToStage(
      pipeline([ran("plan"), ran("deploy"), ran("verify")]),
      "deploy",
    )!;
    expect(result.reopened).toEqual(["deploy", "verify"]);
    expect(result.pipeline.stages.map((s) => s.status)).toEqual([
      "passed",
      "pending",
      "pending",
    ]);
  });

  it("clears the discarded run's output rather than showing stale results", () => {
    const result = revertToStage(pipeline([ran("deploy")]), "deploy")!;
    const subtask = result.pipeline.stages[0].subtasks[0];
    expect(subtask.status).toBe("pending");
    expect(subtask.reply).toBeUndefined();
    expect(subtask.activity).toBeUndefined();
    expect(subtask.sessionId).toBeUndefined();
  });

  it("drops checklist items raised by the discarded run", () => {
    // They gate the task on evidence about work that no longer exists.
    const result = revertToStage(pipeline([ran("deploy")]), "deploy")!;
    expect(result.pipeline.stages[0].checklist).toBeUndefined();
  });

  it("keeps the operator's guidance, which is usually why they reverted", () => {
    const withGuidance: TaskPipeline = {
      ...pipeline([ran("deploy")]),
      guidance: [
        { id: "g1", stageId: "plan", stageName: "Plan", text: "use -Project X", at: "t" },
      ],
    };
    const result = revertToStage(withGuidance, "deploy")!;
    expect(result.pipeline.guidance).toHaveLength(1);
  });

  it("clears a pending question or refusal from the discarded run", () => {
    const withPending: TaskPipeline = {
      ...pipeline([ran("deploy")]),
      pendingQuestion: {
        stageId: "deploy",
        stageName: "Deploy",
        subtaskId: "deploy-1",
        askedAt: "t",
        items: [{ id: "q1", text: "which?" }],
      },
    };
    const result = revertToStage(withPending, "deploy")!;
    expect(result.pipeline.pendingQuestion).toBeUndefined();
  });

  it("returns undefined for a stage that is not in the pipeline", () => {
    expect(revertToStage(pipeline([ran("deploy")]), "nope")).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const original = pipeline([ran("deploy")]);
    revertToStage(original, "deploy");
    expect(original.stages[0].status).toBe("passed");
    expect(original.stages[0].subtasks[0].reply).toBe("did it");
  });

  /**
   * The reason for the re-run, which a plain revert had nowhere to put.
   *
   * Everything a re-run reloads comes from project config, so steering one task meant
   * editing the route every task shares — and the diagnosis of what went wrong was
   * usually on the run being discarded. A cold re-run then reached the same answer for
   * the same reasons, which is what made re-running look like it did nothing.
   */
  describe("the reason it is being re-run", () => {
    it("becomes guidance the new session is given", () => {
      const result = revertToStage(pipeline([ran("deploy")]), "deploy", {
        at: "t2",
        note: "the layout comes from tab 3, not Phase 2",
      })!;
      const guidance = result.pipeline.guidance ?? [];
      expect(guidance).toHaveLength(1);
      expect(guidance[0].text).toBe("the layout comes from tab 3, not Phase 2");
      expect(guidance[0].stageId).toBe("deploy");
    });

    it("appends, so a stage re-run twice keeps both reasons", () => {
      // The earlier reasons are what stop the third attempt repeating the first two.
      const once = revertToStage(pipeline([ran("deploy")]), "deploy", {
        at: "t2",
        note: "first reason",
      })!;
      const twice = revertToStage(once.pipeline, "deploy", {
        at: "t3",
        note: "second reason",
      })!;
      expect((twice.pipeline.guidance ?? []).map((g) => g.text)).toEqual([
        "first reason",
        "second reason",
      ]);
    });

    it("records nothing when no reason is given", () => {
      // The original case for this command stands: the fix was in config, and an
      // empty note must not become an empty instruction handed to the session.
      const result = revertToStage(pipeline([ran("deploy")]), "deploy", {
        at: "t2",
        note: "   ",
      })!;
      expect(result.pipeline.guidance).toBeUndefined();
    });

    it("keeps a derived id, so a replay produces the same pipeline", () => {
      const first = revertToStage(pipeline([ran("deploy")]), "deploy", {
        at: "t2",
        note: "same",
      })!;
      const second = revertToStage(pipeline([ran("deploy")]), "deploy", {
        at: "t2",
        note: "same",
      })!;
      expect(first.pipeline.guidance).toEqual(second.pipeline.guidance);
    });
  });
});

describe("sendBackTargets", () => {
  const reviewed = () =>
    pipeline([
      stage({ id: "plan", name: "Plan", kind: "implementation" }),
      stage({ id: "build", name: "Build", kind: "implementation", status: "passed" }),
      stage({
        id: "sql-review",
        name: "SQL review",
        kind: "domainReview",
        status: "passed",
        addedByRule: "SQL objects changed",
      }),
      stage({ id: "signoff", name: "Sign-off", kind: "humanVerification" }),
    ]);

  it("offers nothing when the stage declares nothing", () => {
    expect(sendBackTargets(reviewed(), "sql-review")).toEqual([]);
  });

  it("offers only the ids the stage declares", () => {
    const p = reviewed();
    p.stages[2].sendBackTo = ["build"];
    expect(sendBackTargets(p, "sql-review").map((s) => s.id)).toEqual(["build"]);
  });

  it("resolves a kind entry, which is all a rule stage can name", () => {
    // A rule applies to any route whose diff matches, so it cannot know the ids.
    const p = reviewed();
    p.stages[2].sendBackTo = ["kind:implementation"];
    // Nearest first: the build, not the plan that preceded it.
    expect(sendBackTargets(p, "sql-review").map((s) => s.id)).toEqual(["build", "plan"]);
  });

  it("ranks a stage that can change the work above a nearer planning stage", () => {
    // The real route this came from plans the deployment *after* implementing, so the
    // nearest earlier match was a planning stage — and a critical finding about a
    // stored procedure was recommended to a stage that cannot touch one.
    const p = pipeline([
      stage({ id: "build", name: "Build", kind: "implementation", status: "passed" }),
      stage({ id: "plan-dev", name: "Plan the DEV landing", kind: "planning", status: "passed" }),
      stage({
        id: "sql-review",
        name: "SQL review",
        kind: "domainReview",
        status: "awaiting-approval",
        sendBackTo: ["kind:implementation", "kind:planning"],
      }),
    ]);
    // Still offered — sending findings to planning is a real move — but chosen by
    // name rather than arrived at by default.
    expect(sendBackTargets(p, "sql-review").map((s) => s.id)).toEqual([
      "build",
      "plan-dev",
    ]);
  });

  it("never offers itself or a later stage, whatever it declares", () => {
    const p = reviewed();
    p.stages[2].sendBackTo = ["sql-review", "signoff", "kind:humanVerification"];
    expect(sendBackTargets(p, "sql-review")).toEqual([]);
  });

  it("ignores a misspelled kind rather than treating it as an id", () => {
    const p = reviewed();
    p.stages[2].sendBackTo = ["kind:implementaton"];
    expect(sendBackTargets(p, "sql-review")).toEqual([]);
  });

  it("offers nothing for the first stage, which has nothing behind it", () => {
    const p = reviewed();
    p.stages[0].sendBackTo = ["kind:implementation"];
    expect(sendBackTargets(p, "plan")).toEqual([]);
  });
});

describe("sendBackToStage", () => {
  const reviewed = () => {
    const p = pipeline([
      stage({ id: "build", name: "Build", kind: "implementation", status: "passed" }),
      stage({
        id: "sql-review",
        name: "SQL review",
        kind: "domainReview",
        status: "passed",
        sendBackTo: ["kind:implementation"],
      }),
      stage({ id: "signoff", name: "Sign-off", kind: "humanVerification" }),
    ]);
    p.stages[1].subtasks[0].reply = "## Critical\n- The migration drops a column.";
    return p;
  };

  const input = {
    targetStageId: "build",
    fromStageId: "sql-review",
    findings: "**Critical**\n- The migration drops a column.",
    at: "2026-08-04T12:00:00.000Z",
  };

  it("re-opens the target and everything after it", () => {
    const result = sendBackToStage(reviewed(), input)!;
    expect(result.reopened).toEqual(["build", "sql-review", "signoff"]);
    expect(result.pipeline.stages.map((s) => s.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("carries the findings as guidance, which a revert cannot discard", () => {
    // The whole point: the reviewing stage's own reply goes with the re-run, so
    // without this the act of sending work back destroys the reason for it.
    const result = sendBackToStage(reviewed(), input)!;
    expect(result.pipeline.stages[1].subtasks[0].reply).toBeUndefined();
    const note = result.pipeline.guidance![0];
    expect(note.stageId).toBe("build");
    expect(note.text).toContain("Sent back from \"SQL review\"");
    expect(note.text).toContain("The migration drops a column.");
  });

  it("records what the discarded run had cost, and who sent it back", () => {
    // The number that was disappearing. A revert clears `activity`, and cost lives
    // there — so a task sent back six times reported the price of its last attempt
    // and looked calm, which is the opposite of what it felt like to run.
    const p = reviewed();
    p.stages[0].subtasks[0].startedAt = "2026-08-04T11:00:00.000Z";
    p.stages[0].subtasks[0].finishedAt = "2026-08-04T11:44:00.000Z";
    p.stages[0].subtasks[0].activity = { costUsd: 12.48 };

    const result = sendBackToStage(p, input)!;
    const [entry] = result.pipeline.discarded!;
    expect(entry.stageId).toBe("build");
    expect(entry.costUsd).toBeCloseTo(12.48);
    expect(entry.elapsedMs).toBe(44 * 60 * 1000);
    // Attributed to the review that caused it: which reviews cost the route re-runs
    // is the question the ledger exists to answer.
    expect(entry.reason).toBe('sent back from "SQL review"');
  });

  it("does not record stages after the target that never ran", () => {
    // They are re-opened too, but a zero entry each would fill the ledger with work
    // that never happened and bury the run that actually cost something.
    const result = sendBackToStage(reviewed(), input)!;
    expect((result.pipeline.discarded ?? []).map((d) => d.stageId)).not.toContain(
      "signoff",
    );
  });

  it("appends the operator's own note after the findings", () => {
    const result = sendBackToStage(reviewed(), { ...input, note: "Leave Motability alone." })!;
    expect(result.pipeline.guidance![0].text).toContain("Leave Motability alone.");
  });

  it("keeps guidance given earlier", () => {
    const p = reviewed();
    p.guidance = [
      { id: "g1", stageId: "build", stageName: "Build", text: "Only this project.", at: "x" },
    ];
    const result = sendBackToStage(p, input)!;
    expect(result.pipeline.guidance!.map((g) => g.id)).toEqual([
      "g1",
      expect.stringContaining("sendback-"),
    ]);
  });

  it("refuses a target the stage does not declare", () => {
    const p = reviewed();
    p.stages[1].sendBackTo = [];
    expect(sendBackToStage(p, input)).toBeUndefined();
  });

  it("refuses to send forward, or to itself", () => {
    const p = reviewed();
    p.stages[1].sendBackTo = ["signoff", "sql-review"];
    expect(sendBackToStage(p, { ...input, targetStageId: "signoff" })).toBeUndefined();
    expect(sendBackToStage(p, { ...input, targetStageId: "sql-review" })).toBeUndefined();
  });

  it("does not mutate the pipeline it was given", () => {
    const p = reviewed();
    sendBackToStage(p, input);
    expect(p.stages[0].status).toBe("passed");
    expect(p.guidance).toBeUndefined();
  });
});

describe("sendBackTargets and deployment stages", () => {
  it("does not offer a deployment stage for kind:implementation", () => {
    // The regression that motivated a separate `deployment` kind. A route that
    // deploys before it reviews had its deployment as the nearest earlier
    // "implementation" stage, so the obvious way back from a failed review was to
    // run the deployment again rather than fix what failed.
    const p = pipeline([
      stage({ id: "write", name: "Write migration", kind: "implementation" }),
      stage({ id: "deploy", name: "Deploy to DEV", kind: "deployment" }),
      stage({
        id: "review",
        name: "SQL review",
        kind: "domainReview",
        sendBackTo: ["kind:implementation"],
      }),
    ]);
    expect(sendBackTargets(p, "review").map((s) => s.id)).toEqual(["write"]);
  });
});

describe("sendBackTargets and planning stages", () => {
  const route = (sendBackTo: string[]) =>
    pipeline([
      stage({ id: "plan", name: "Plan", kind: "planning" }),
      stage({ id: "write", name: "Write it", kind: "implementation" }),
      stage({ id: "deploy", name: "Deploy", kind: "deployment" }),
      stage({ id: "review", name: "Review", kind: "domainReview", sendBackTo }),
    ]);

  it("does not offer planning for kind:implementation", () => {
    // "Back to whoever wrote this" must not silently mean "plan it all again":
    // re-opening planning discards every stage after it.
    expect(sendBackTargets(route(["kind:implementation"]), "review").map((s) => s.id)).toEqual([
      "write",
    ]);
  });

  it("offers planning when it is asked for by name", () => {
    // A review that finds an object in the wrong layer has found a planning error,
    // and re-implementing against the same plan reproduces it.
    expect(
      sendBackTargets(route(["kind:implementation", "kind:planning"]), "review").map((s) => s.id),
    ).toEqual(["write", "plan"]);
  });
});

describe("repositionRuleStages", () => {
  const barrier = (stages: readonly TaskStage[]) => {
    const at = stages.findIndex(
      (s) =>
        (s.status === "pending" || s.status === "awaiting-approval") &&
        (s.kind === "deployment" || s.kind === "humanVerification"),
    );
    return at === -1 ? stages.length : at;
  };

  const spoiled = () =>
    pipeline([
      stage({ id: "migration", kind: "implementation", status: "passed" }),
      stage({ id: "deploy", name: "Deploy to DEV", kind: "deployment", status: "pending" }),
      stage({ id: "verify", kind: "test", status: "pending" }),
      stage({ id: "r-sql", kind: "domainReview", status: "pending", addedByRule: "SQL changed" }),
      stage({ id: "signoff", kind: "humanVerification", status: "pending" }),
    ]);

  it("moves a pending review ahead of the deployment it should precede", () => {
    // The repair for an existing task: an earlier build spliced reviews before the
    // first human gate, which in this route is after the deploy.
    const result = repositionRuleStages(spoiled(), barrier);
    expect(result.moved).toEqual(["r-sql"]);
    expect(result.pipeline.stages.map((s) => s.id)).toEqual([
      "migration",
      "r-sql",
      "deploy",
      "verify",
      "signoff",
    ]);
  });

  it("leaves a review that has already run where it ran", () => {
    // Re-ordering history to match the current rule would misreport what happened.
    const p = spoiled();
    p.stages[3].status = "passed";
    const result = repositionRuleStages(p, barrier);
    expect(result.moved).toEqual([]);
    expect(result.pipeline).toBe(p);
  });

  it("leaves route stages alone, however they are ordered", () => {
    const p = spoiled();
    delete p.stages[3].addedByRule;
    expect(repositionRuleStages(p, barrier).moved).toEqual([]);
  });

  it("does nothing when the reviews are already in front", () => {
    const p = pipeline([
      stage({ id: "r-sql", kind: "domainReview", status: "pending", addedByRule: "x" }),
      stage({ id: "deploy", kind: "deployment", status: "pending" }),
    ]);
    expect(repositionRuleStages(p, barrier).moved).toEqual([]);
  });

  it("does not mutate the pipeline it was given", () => {
    const p = spoiled();
    repositionRuleStages(p, barrier);
    expect(p.stages.map((s) => s.id)[1]).toBe("deploy");
  });
});

describe("syncHandoffs", () => {
  const existing = (): TaskPipeline =>
    pipeline([
      stage({
        id: "plan",
        name: "Plan",
        kind: "planning",
        status: "passed",
        subtasks: [
          { id: "plan-1", title: "Plan", prompt: "p", status: "done", reply: "Put it in apps/." },
        ],
      }),
      stage({ id: "build", name: "Build", kind: "implementation", status: "pending" }),
    ]);

  const source = (handoff: boolean) => ({
    routes: [
      {
        id: "sql-change",
        label: "SQL",
        description: "",
        stages: [
          { id: "plan", label: "Plan", kind: "planning" as const, intent: "p", splittable: false, gate: "auto" as const, handoff },
          { id: "build", label: "Build", kind: "implementation" as const, intent: "b", splittable: false, gate: "auto" as const },
        ],
      },
    ],
    rules: [],
  });

  it("enables the flag on a task created before the field existed", () => {
    const result = syncHandoffs(existing(), source(true), "t1");
    expect(result.enabled).toEqual(["plan"]);
    expect(result.pipeline.stages[0].handoff).toBe(true);
  });

  it("backfills what an already-passed stage concluded", () => {
    // Otherwise the answer would be "recreate your task", discarding everything
    // already approved — and the reply is right there in the state file.
    const result = syncHandoffs(existing(), source(true), "t1");
    expect(result.backfilled).toEqual(["plan"]);
    expect(result.pipeline.handoffs).toEqual([
      { stageId: "plan", stageName: "Plan", text: "Put it in apps/.", at: "t1" },
    ]);
  });

  it("does not backfill twice", () => {
    const once = syncHandoffs(existing(), source(true), "t1");
    const twice = syncHandoffs(once.pipeline, source(true), "t2");
    expect(twice.backfilled).toEqual([]);
    expect(twice.pipeline.handoffs).toHaveLength(1);
  });

  it("turns the flag off again when config says so", () => {
    const on = syncHandoffs(existing(), source(true), "t1");
    const off = syncHandoffs(on.pipeline, source(false), "t2");
    expect(off.pipeline.stages[0].handoff).toBeUndefined();
  });

  it("does not backfill a stage that has not passed", () => {
    const p = existing();
    p.stages[0].status = "pending";
    expect(syncHandoffs(p, source(true), "t1").backfilled).toEqual([]);
  });

  it("returns the same pipeline when nothing differs", () => {
    const p = existing();
    expect(syncHandoffs(p, source(false), "t1").pipeline).toBe(p);
  });
});

/**
 * Which stages a guidance note is actually handed to.
 *
 * Everything used to go to everything, which is right for an approval note and wrong
 * for the two kinds that came later. Both failures happened on one route in a morning:
 * a DEV deployment preview was given three reviews' findings that had been fixed two
 * stages earlier and spent part of its report declining to re-litigate them, and a
 * re-run was given a correction's bug report about the build it was replacing and
 * stopped to ask three questions about an exception that no longer existed.
 */
describe("guidanceFor", () => {
  const withNotes = (
    notes: NonNullable<TaskPipeline["guidance"]>,
    stages: TaskStage[] = [stage({ id: "build" }), stage({ id: "review" })],
  ): TaskPipeline => ({ ...pipeline(stages), guidance: notes });

  const note = (overrides: Partial<NonNullable<TaskPipeline["guidance"]>[number]>) => ({
    id: "g1",
    stageId: "build",
    stageName: "Build",
    text: "note",
    at: "t",
    ...overrides,
  });

  it("gives an approval note to every stage, as it always has", () => {
    const p = withNotes([note({ text: "use -Project X", scope: "route" })]);
    expect(guidanceFor(p, "review")).toEqual(["use -Project X"]);
  });

  it("treats a note with no scope as route-wide", () => {
    // Pipelines written before the distinction existed keep the behaviour they had.
    const p = withNotes([note({ text: "legacy" })]);
    expect(guidanceFor(p, "review")).toEqual(["legacy"]);
  });

  it("keeps a stage-scoped note away from other stages", () => {
    const p = withNotes([note({ text: "findings about the build", scope: "stage" })]);
    expect(guidanceFor(p, "build")).toEqual(["findings about the build"]);
    expect(guidanceFor(p, "review")).toEqual([]);
  });

  it("retires a stage-scoped note once its stage has passed", () => {
    // By then it either worked or came back as a new finding. Either way it is no
    // longer an instruction, and a re-run of a later stage must not inherit it.
    const p = withNotes(
      [note({ text: "fix the cast", scope: "stage" })],
      [stage({ id: "build", status: "passed" })],
    );
    expect(guidanceFor(p, "build")).toEqual([]);
  });

  it("keeps it while the stage is being redone, which is the point", () => {
    const p = withNotes(
      [note({ text: "fix the cast", scope: "stage" })],
      [stage({ id: "build", status: "active" })],
    );
    expect(guidanceFor(p, "build")).toEqual(["fix the cast"]);
  });

  it("gives a session with no stage only the route-wide notes", () => {
    // A hand-driven chat is not a stage, and a correction aimed at one has no
    // meaning there.
    const p = withNotes([
      note({ id: "g1", text: "route", scope: "route" }),
      note({ id: "g2", text: "stage", scope: "stage" }),
    ]);
    expect(guidanceFor(p, undefined)).toEqual(["route"]);
  });

  it("is empty for a pipeline with no guidance", () => {
    expect(guidanceFor(pipeline([stage({ id: "build" })]), "build")).toEqual([]);
    expect(guidanceFor(undefined, "build")).toEqual([]);
  });
});
