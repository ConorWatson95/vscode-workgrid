import { describe, expect, it } from "vitest";
import {
  externalWaitSince,
  formatWaitingSince,
  groupForTask,
  groupTasks,
  GROUP_ORDER,
} from "./taskGrouping";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { activeStageLabel } from "./stagePresentation";

const stage = (over: Partial<TaskStage> = {}): TaskStage =>
  ({
    id: "s1",
    name: "S1",
    kind: "implementation",
    status: "pending",
    intent: "",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...over,
  }) as TaskStage;

const pipeline = (stages: TaskStage[], over: Partial<TaskPipeline> = {}): TaskPipeline =>
  ({ routeId: "sql-change", stages, ...over }) as TaskPipeline;

const of = (pipe?: TaskPipeline, heldCalls = 0, status = "active") =>
  groupForTask({ status, pipeline: pipe, heldCalls });

describe("groupForTask", () => {
  it("files a task with no route separately", () => {
    expect(of(undefined)).toBe("no-route");
    expect(of(pipeline([]))).toBe("no-route");
  });

  it("files an archived task by its status, whatever its route says", () => {
    expect(of(pipeline([stage({ status: "active" })]), 0, "archived")).toBe("archived");
  });

  it("needs you when a tool call is held", () => {
    // The most urgent thing the list can show: a CLI stopped mid-turn.
    expect(of(pipeline([stage({ status: "active" })]), 1)).toBe("needs-you");
  });

  it("needs you for an unanswered question", () => {
    const p = pipeline([stage({ status: "active" })], {
      pendingQuestion: { stageId: "s1", stageName: "S1", subtaskId: "s1-1", items: [{ id: "q1", question: "Which?" }] },
    } as Partial<TaskPipeline>);
    expect(of(p)).toBe("needs-you");
  });

  it("does not need you for a question already answered", () => {
    const p = pipeline([stage({ status: "active" })], {
      pendingQuestion: {
        stageId: "s1",
        stageName: "S1",
        subtaskId: "s1-1",
        items: [{ id: "q1", question: "Which?", answer: "DEV" }],
      },
    } as Partial<TaskPipeline>);
    expect(of(p)).toBe("working");
  });

  it("needs you for a refusal not yet granted", () => {
    const p = pipeline([stage({ status: "active" })], {
      pendingDenials: {
        stageId: "s1",
        stageName: "S1",
        subtaskId: "s1-1",
        refusedAt: "t",
        items: [{ tool: "Bash", reason: "denied" }],
      },
    } as Partial<TaskPipeline>);
    expect(of(p)).toBe("needs-you");
  });

  it("needs you at an approval gate", () => {
    expect(of(pipeline([stage({ status: "awaiting-approval" })]))).toBe("needs-you");
  });

  it("needs you when a stage failed, since it cannot resolve itself", () => {
    expect(of(pipeline([stage({ status: "failed" })]))).toBe("needs-you");
  });

  it("needs you at a verification gate, outstanding items or not", () => {
    const withItems = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "check", checked: false }] }),
      stage({ id: "b", kind: "humanVerification", status: "pending" }),
    ]);
    expect(of(withItems)).toBe("needs-you");
    const ticked = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "check", checked: true }] }),
      stage({ id: "b", kind: "humanVerification", status: "pending" }),
    ]);
    expect(of(ticked)).toBe("needs-you");
  });

  it("does not treat items raised mid-route as needing you yet", () => {
    // They are real but not blocking, and counting them would put nearly every
    // harnessed task in this group — the sifting problem again.
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "check", checked: false }] }),
      stage({ id: "b", status: "active" }),
      stage({ id: "c", kind: "humanVerification", status: "pending" }),
    ]);
    expect(of(p)).toBe("working");
  });

  it("is working when a stage is running and nothing is blocked", () => {
    expect(of(pipeline([stage({ status: "active" })]))).toBe("working");
  });

  it("is working when the running stage is a verification gate", () => {
    // RU-550's UAT acceptance, filed under "Needs you" while its session was running.
    // A gate settles to `awaiting-approval` when it finishes, so `active` means work in
    // flight — the same thing it means for every other kind, which does land in Working.
    // Asking for a decision that does not exist yet is the milder half; hiding a running
    // task from the group that shows running tasks is the half that misleads.
    const p = pipeline([
      stage({ id: "a", status: "passed" }),
      stage({ id: "uat", kind: "humanVerification", status: "active" }),
    ]);
    expect(of(p)).toBe("working");
  });

  it("still needs you at a running gate's items once it has stopped", () => {
    // The same stage one transition later: nothing has changed about the checklist, only
    // that a person is now being asked. This is what keeps the fix from switching the
    // gate off rather than deferring it.
    const p = pipeline([
      stage({
        id: "a",
        status: "passed",
        checklist: [{ id: "c1", text: "check", checked: false }],
      }),
      stage({ id: "uat", kind: "humanVerification", status: "awaiting-approval" }),
    ]);
    expect(of(p)).toBe("needs-you");
  });

  it("keeps a held call ahead of a running gate", () => {
    // A gate running a session can still be blocked mid-turn, and an answer is the only
    // thing that releases it — so Working must not absorb it.
    const p = pipeline([stage({ id: "uat", kind: "humanVerification", status: "active" })]);
    expect(groupForTask({ status: "ready", pipeline: p, heldCalls: 1 })).toBe("needs-you");
  });

  it("is parked when nothing runs and nothing waits on you", () => {
    expect(of(pipeline([stage({ id: "a", status: "passed" }), stage({ id: "b", status: "pending" })]))).toBe(
      "parked",
    );
  });

  it("is done when every stage resolved", () => {
    expect(
      of(pipeline([stage({ id: "a", status: "passed" }), stage({ id: "b", status: "skipped" })])),
    ).toBe("done");
  });
});

describe("a gate somebody else answers", () => {
  const gate = (over: Partial<TaskStage> = {}) =>
    stage({
      id: "uat",
      name: "UAT acceptance",
      kind: "humanVerification",
      checklistScope: "uat",
      checklistAudience: "others",
      ...over,
    });

  it("is waiting on others while its items are outstanding", () => {
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "sign off", checked: false, scope: "uat", raisedByStage: "a" }] }),
      gate({ status: "awaiting-approval" }),
    ]);
    expect(of(p)).toBe("waiting-others");
  });

  it("is waiting on others when the gate has no items at all", () => {
    // The correction. Keying purely on outstanding items read an empty checklist as an
    // answered one, so a DEV sign-off that raised nothing sat in "needs you" with
    // nothing for the operator to read. Absence of a checklist is not evidence that a
    // verification happened.
    const p = pipeline([
      stage({ id: "a", status: "passed" }),
      gate({ status: "awaiting-approval" }),
    ]);
    expect(of(p)).toBe("waiting-others");
  });

  it("is waiting on others when its items were routed elsewhere", () => {
    // A real state: eleven sign-off items written before scopes existed, so they carry
    // none and resolve to a different gate. The sign-off itself is still outstanding.
    const p = pipeline([
      stage({
        id: "a",
        status: "passed",
        checklist: [{ id: "c1", text: "exercise it", checked: false, scope: "live-site", raisedByStage: "a" }],
      }),
      gate({ status: "awaiting-approval" }),
      gate({ id: "live", name: "Verify live", status: "pending", checklistScope: "live-site", checklistAudience: undefined }),
    ]);
    expect(of(p)).toBe("waiting-others");
  });

  it("is yours again once the items are ticked", () => {
    // Approving is a decision only the operator makes, so a gate with nothing
    // outstanding is a click and belongs back in the list they scan.
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "sign off", checked: true, scope: "uat", raisedByStage: "a" }] }),
      gate({ status: "awaiting-approval" }),
    ]);
    expect(of(p)).toBe("needs-you");
  });

  it("stays yours when the gate did not declare an audience", () => {
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "sign off", checked: false, scope: "uat", raisedByStage: "a" }] }),
      gate({ status: "awaiting-approval", checklistAudience: undefined }),
    ]);
    expect(of(p)).toBe("needs-you");
  });

  it("does not claim a task whose items belong to an earlier gate", () => {
    // Per-gate, not pipeline-wide: an item the local gate answers for must not file
    // the task as waiting on testers.
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "run it locally", checked: false, scope: "local", raisedByStage: "a" }] }),
      stage({ id: "local", name: "Local check", kind: "humanVerification", status: "awaiting-approval", checklistScope: "local" }),
      gate({ status: "pending" }),
    ]);
    expect(of(p)).toBe("needs-you");
  });

  it("is yours when a stage failed, whatever the gate is waiting on", () => {
    const p = pipeline([
      stage({ id: "a", status: "failed", checklist: [{ id: "c1", text: "sign off", checked: false, scope: "uat", raisedByStage: "a" }] }),
      gate({ status: "awaiting-approval" }),
    ]);
    expect(of(p)).toBe("needs-you");
  });

  it("outranks the external wait with a held tool call", () => {
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "sign off", checked: false, scope: "uat", raisedByStage: "a" }] }),
      gate({ status: "awaiting-approval" }),
    ]);
    expect(of(p, 1)).toBe("needs-you");
  });

  it("reports when the wait started, so a forgotten task is visible", () => {
    const p = pipeline([
      stage({ id: "a", status: "passed", checklist: [{ id: "c1", text: "sign off", checked: false, scope: "uat", raisedByStage: "a" }] }),
      gate({ status: "awaiting-approval", startedAt: "2026-08-01T09:00:00.000Z" }),
    ]);
    expect(externalWaitSince(p)).toBe("2026-08-01T09:00:00.000Z");
    expect(externalWaitSince(pipeline([stage({ status: "active" })]))).toBeUndefined();
  });
});

describe("formatWaitingSince", () => {
  const at = (iso: string) => Date.parse(iso);

  it("reports days and hours, not seconds", () => {
    // These waits are answered on somebody else's schedule, so seconds are
    // precision about a number nobody acts on.
    expect(formatWaitingSince("2026-08-13T09:00:00Z", at("2026-08-13T09:30:00Z"))).toBe("30m");
    expect(formatWaitingSince("2026-08-13T09:00:00Z", at("2026-08-13T14:00:00Z"))).toBe("5h");
    expect(formatWaitingSince("2026-08-01T09:00:00Z", at("2026-08-13T09:00:00Z"))).toBe("12d");
  });

  it("does not invent an age it cannot compute", () => {
    expect(formatWaitingSince("not a date", at("2026-08-13T09:00:00Z"))).toBe("waiting");
  });
});

describe("groupTasks", () => {
  it("orders groups worst-first and drops empty ones", () => {
    const grouped = groupTasks(["a", "b", "c"], (item) =>
      item === "a" ? "parked" : item === "b" ? "needs-you" : "parked",
    );
    expect(grouped.map((g) => g.id)).toEqual(["needs-you", "parked"]);
    expect(grouped[1].items).toEqual(["a", "c"]);
  });

  it("returns one group when everything lands together", () => {
    // The caller flattens this case: one wrapper around one list hides tasks
    // without organising anything.
    expect(groupTasks(["a", "b"], () => "working")).toHaveLength(1);
  });

  it("labels every group it can produce", () => {
    for (const id of GROUP_ORDER) {
      expect(groupTasks(["x"], () => id)[0].label.length).toBeGreaterThan(0);
    }
  });
});

describe("a gate the route has not reached", () => {
  /**
   * The real shape, from `sql-change` on "Nissan GB Campaigns - Disc Quantity Error".
   *
   * A passed behaviour review raised 7 items; the route declares no checklist scopes, so
   * they pool onto the first verification gate. That gate is `sc-signoff` — audience
   * "others", still pending, three stages away. The route is stopped at `sc-verify`,
   * awaiting the operator's own approval.
   */
  const atOwnApproval = () =>
    pipeline([
      stage({
        id: "r-runtime-qa-plan",
        kind: "behaviourReview",
        status: "passed",
        checklist: Array.from({ length: 7 }, (_, i) => ({
          id: `c${i}`,
          text: `check ${i}`,
          checked: false,
        })),
      } as Partial<TaskStage>),
      stage({ id: "sc-verify", kind: "test", status: "awaiting-approval" }),
      stage({ id: "sc-dev-promote", kind: "deployment", status: "pending" }),
      stage({
        id: "sc-signoff",
        kind: "humanVerification",
        status: "pending",
        checklistAudience: "others",
      } as Partial<TaskStage>),
    ]);

  it("does not file a task as delegated for a pending external gate", () => {
    // "Verify on DEV" is the operator verifying. Filing it under waiting-on-others moves
    // it out of the list they scan to decide what to pick up — the exact sifting failure
    // the group exists to prevent, in reverse.
    expect(of(atOwnApproval())).toBe("needs-you");
    // And nothing to show an age against, which is the tell: a pending stage never started.
    expect(externalWaitSince(atOwnApproval())).toBeUndefined();
  });

  it("still files a task as delegated once the external gate is the stage in play", () => {
    // The feature has to keep working: same route, same items, gate reached.
    const reached = pipeline([
      stage({
        id: "r-runtime-qa-plan",
        kind: "behaviourReview",
        status: "passed",
        checklist: [{ id: "c0", text: "check", checked: false }],
      } as Partial<TaskStage>),
      stage({ id: "sc-verify", kind: "test", status: "passed" }),
      stage({
        id: "sc-signoff",
        kind: "humanVerification",
        status: "awaiting-approval",
        checklistAudience: "others",
        startedAt: "2026-08-14T06:00:00.000Z",
      } as Partial<TaskStage>),
    ]);
    expect(of(reached)).toBe("waiting-others");
    expect(externalWaitSince(reached)).toBe("2026-08-14T06:00:00.000Z");
  });

  it("does not file a task as delegated while the external gate is still running", () => {
    // Same reason a pending one is not: a gate producing its own checklist items has
    // handed nothing to anybody. It also has a startedAt, so counting it would have
    // reported the session's own start as the age of somebody else's wait.
    const running = pipeline([
      stage({ id: "a", status: "passed" }),
      stage({
        id: "sc-signoff",
        kind: "humanVerification",
        status: "active",
        checklistAudience: "others",
        startedAt: "2026-08-20T08:58:37.521Z",
      } as Partial<TaskStage>),
    ]);
    expect(of(running)).toBe("working");
    expect(externalWaitSince(running)).toBeUndefined();
  });

  it("keeps a failed stage ahead of a reached external gate", () => {
    // A broken route is the operator's whatever the task is nominally waiting on.
    const broken = pipeline([
      stage({ id: "sc-migration", status: "failed" }),
      stage({
        id: "sc-signoff",
        kind: "humanVerification",
        status: "awaiting-approval",
        checklistAudience: "others",
        checklist: [{ id: "c0", text: "check", checked: false }],
      } as Partial<TaskStage>),
    ]);
    expect(of(broken)).toBe("needs-you");
  });
});

describe("a route that stopped rather than being parked", () => {
  // `Purchases vs Sales Phase 3` hit the step limit and sat under "Parked" — a word for
  // a decision — with its only account of itself a toast already dismissed.
  const stopped = (extra: Record<string, unknown> = {}) => ({
    status: "ready",
    heldCalls: 0,
    pipeline: {
      routeId: "r",
      stages: [
        { id: "a", name: "A", kind: "implementation", status: "passed", intent: "", splittable: false, requiresApproval: false, subtasks: [] },
        { id: "b", name: "B", kind: "codeReview", status: "pending", intent: "", splittable: false, requiresApproval: false, subtasks: [] },
      ],
      lastAdvance: { reason: "exhausted", at: "t1", steps: 40 },
      ...extra,
    },
  }) as never;

  it("is yours, not parked", () => {
    expect(groupForTask(stopped())).toBe("needs-you");
  });

  it("says so on the row, naming what it stopped in front of", () => {
    const label = activeStageLabel((stopped() as { pipeline: TaskPipeline }).pipeline);
    expect(label).toContain("stopped");
    expect(label).toContain("B");
    expect(label).toContain("advance again");
  });

  it("is parked again once the reason is cleared", () => {
    const clean = stopped() as { pipeline: { lastAdvance?: unknown } };
    clean.pipeline.lastAdvance = undefined;
    expect(groupForTask(clean as never)).toBe("parked");
  });

  it("never outranks something that describes the task better", () => {
    // A failed stage, a gate or a question is a truer account than "it stopped".
    const failed = stopped() as { pipeline: { stages: { status: string }[] } };
    failed.pipeline.stages[1].status = "failed";
    expect(groupForTask(failed as never)).toBe("needs-you");

    const working = stopped() as { pipeline: { stages: { status: string }[] } };
    working.pipeline.stages[1].status = "active";
    expect(groupForTask(working as never)).toBe("working");
  });
});
