import { describe, expect, it } from "vitest";
import { changedNothing, correctionChangedNothing } from "./stageProductivity";
import { Subtask, TaskStage } from "./taskPipeline";

const subtask = (overrides: Partial<Subtask> = {}): Subtask => ({
  id: "s1",
  title: "Fix it",
  prompt: "p",
  status: "done",
  startedAt: "t1",
  finishedAt: "t2",
  ...overrides,
});

const stage = (overrides: Partial<TaskStage> = {}): TaskStage => ({
  id: "implement",
  name: "Implement",
  kind: "implementation",
  status: "passed",
  intent: "Fix the defect.",
  splittable: false,
  requiresApproval: false,
  subtasks: [subtask()],
  ...overrides,
});

/**
 * The check that needs no cooperation from the reply.
 *
 * Every other defence depends on the stage saying it did not do its work. Each closed a
 * real hole and each has the same weakness: a stage that declines in prose passes. The
 * case that prompted this produced an excellent root-cause analysis, concluded the fix
 * was out of scope, wrote "Why I stopped", and the route advanced onto stages assuming a
 * fix that did not exist.
 */
describe("an implementation stage that changed nothing", () => {
  it("is caught when no subtask wrote a file", () => {
    expect(
      changedNothing(stage({ subtasks: [subtask({ activity: { toolCounts: { Read: 9 } } })] })),
    ).toBe(true);
  });

  it("says nothing when no activity was recorded at all", () => {
    // Absence of a measurement is not evidence of zero. A subtask that ran before
    // activity was recorded, or whose watcher produced nothing, tells us nothing about
    // what it wrote — and holding a stage on a missing measurement is the same error as
    // reporting a cost of zero for a session that reported none.
    expect(changedNothing(stage())).toBe(false);
  });

  it("is not caught when something was written", () => {
    expect(
      changedNothing(
        stage({ subtasks: [subtask({ activity: { pathsWritten: ["src/a.ts"] } })] }),
      ),
    ).toBe(false);
  });

  it("counts writes from any subtask of a split stage", () => {
    // One unit investigating and another editing is a normal split, not a stage that
    // did nothing.
    expect(
      changedNothing(
        stage({
          subtasks: [
            subtask({ id: "s1" }),
            subtask({ id: "s2", activity: { pathsWritten: ["src/b.ts"] } }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("leaves every other kind of stage alone", () => {
    // A review, a deployment and an assessment all legitimately write nothing, and a
    // check that fires constantly is one people approve through without reading.
    for (const kind of ["codeReview", "domainReview", "deployment", "assessment", "behaviourReview"] as const) {
      expect(changedNothing(stage({ kind }))).toBe(false);
    }
  });

  it("says nothing about a stage that never ran", () => {
    expect(
      changedNothing(stage({ status: "pending", subtasks: [subtask({ status: "pending", startedAt: undefined })] })),
    ).toBe(false);
  });

  it("defers to a declared check that passed", () => {
    // The whole reason this exists is a stage backed by nothing but its own account.
    // Where something other than the agent certified the work, an unusual way of making
    // the change is not the harness's business.
    expect(
      changedNothing(
        stage({
          subtasks: [subtask({ activity: { toolCounts: { Read: 3 } } })],
          verification: { command: "dotnet build", exitCode: 0, at: "t" },
        }),
      ),
    ).toBe(false);
  });

  it("still holds when the declared check failed", () => {
    expect(
      changedNothing(
        stage({
          subtasks: [subtask({ activity: { toolCounts: { Read: 3 } } })],
          verification: { command: "dotnet build", exitCode: 1, at: "t" },
        }),
      ),
    ).toBe(true);
  });

  it("counts running a command as not having written", () => {
    // The case worth stopping on is exactly this: read-only investigation, reported as
    // completed work.
    expect(
      changedNothing(
        stage({ subtasks: [subtask({ activity: { commands: ["sqlcmd -Q \"select 1\""] } })] }),
      ),
    ).toBe(true);
  });
});

describe("a stage amended because its input changed upstream", () => {
  it("is not held when the amendment writes nothing but the stage already had", () => {
    // An amendment that correctly concludes "the upstream change does not affect me"
    // writes no files. Held on that alone, a single Plan correction rippling through
    // seventeen stages would raise a wall of holds for stages that did exactly the
    // right thing — and a check that fires constantly is one people approve through
    // without reading, which is the failure this check exists to avoid.
    //
    // Safe because an amended stage *keeps* what it produced before: the earlier
    // subtask's activity is still there, so the stage as a whole did change files.
    // That follows from retention rather than from a rule here, which is precisely
    // why it is pinned — a future change that cleared prior activity on amendment
    // would reintroduce the wall of holds and nothing else would catch it.
    const amended = stage({
      subtasks: [
        subtask({ id: "s1", activity: { pathsWritten: ["src/Report.cs"] } }),
        subtask({
          id: "s1-amend-1",
          title: 'Amend for "Plan"',
          correction: {
            finding: "Plan changed",
            at: "t3",
            upstream: { stageId: "plan", stageName: "Plan" },
          },
          activity: { pathsWritten: [] },
        }),
      ],
    });
    expect(changedNothing(amended)).toBe(false);
  });

  it("is still held when the stage has written nothing at all", () => {
    const neverWrote = stage({
      subtasks: [
        subtask({ id: "s1", activity: { pathsWritten: [] } }),
        subtask({ id: "s1-amend-1", activity: { pathsWritten: [] } }),
      ],
    });
    expect(changedNothing(neverWrote)).toBe(true);
  });
});

/**
 * The same argument one level in.
 *
 * `CORRECTION-DECLINED` was wired end to end and still depended on the model emitting
 * it. A plan correction handed a genuine scope change argued the case correctly and at
 * length, wrote no files, used no marker, and passed — leaving eight stages to run
 * against a plan that still described the old requirement.
 */
describe("a correction that changed nothing", () => {
  const correction = (overrides: Partial<Subtask> = {}): Subtask =>
    subtask({
      id: "plan-correct-1",
      title: "Correction 1",
      correction: { finding: "The bucket rule is wrong", at: "t3" },
      ...overrides,
    });

  it("is caught when the correction wrote no file", () => {
    expect(correctionChangedNothing(correction({ activity: { toolCounts: { Read: 12 } } }))).toBe(
      true,
    );
  });

  it("passes a correction that changed its stage's output", () => {
    expect(
      correctionChangedNothing(correction({ activity: { pathsWritten: ["docs/plans/rc-plan.md"] } })),
    ).toBe(false);
  });

  it("ignores an amendment, which correctly writes nothing when unaffected", () => {
    // The common case in a cascade: one correction re-opens seventeen stages and most
    // of them are right to change nothing. Held on that, the check would fire
    // constantly, which is how a check stops being read.
    expect(
      correctionChangedNothing(
        correction({
          id: "nav-amend-1",
          correction: {
            finding: "Plan changed",
            at: "t3",
            upstream: { stageId: "plan", stageName: "Plan" },
          },
          activity: { pathsWritten: [] },
        }),
      ),
    ).toBe(false);
  });

  it("ignores an ordinary subtask, which `changedNothing` already covers", () => {
    expect(correctionChangedNothing(subtask({ activity: { pathsWritten: [] } }))).toBe(false);
  });

  it("treats a missing activity record as unmeasured, not as zero", () => {
    // The rule `stageUsage` and `changedNothing` both follow: holding a stage on the
    // strength of a measurement that was never taken is the same error as reporting a
    // cost of zero for a session that reported none.
    expect(correctionChangedNothing(correction())).toBe(false);
  });

  it("holds a correction to a stage of any kind, unlike `changedNothing`", () => {
    // `changedNothing` is confined to implementation because a review legitimately
    // writes nothing. A *correction* to a review rewrites its findings, and one to a
    // plan rewrites the plan — every medium `correctionMedium` names is a file.
    expect(
      correctionChangedNothing(
        correction({ id: "review-correct-1", activity: { toolCounts: { Grep: 4 } } }),
      ),
    ).toBe(true);
  });
});

describe("a stage whose work may not apply", () => {
  const wroteNothing = (over: Record<string, unknown> = {}) =>
    ({
      id: "rework",
      name: "UAT rework",
      kind: "implementation",
      status: "active",
      intent: "Fix what UAT found.",
      splittable: false,
      requiresApproval: false,
      subtasks: [
        {
          id: "rework-1",
          title: "Rework",
          prompt: "p",
          status: "done",
          startedAt: "2026-09-02T00:00:00.000Z",
          activity: { toolCounts: { Read: 3 } },
        },
      ],
      ...over,
    }) as never;

  // Measured 2 Sep 2026: rc-nav-permissions ran 38 times across 8 task instances, wrote
  // zero files and was held every time — 23 of 98 approvals in a week, all clearing this
  // hold. Its own intent said doing nothing was the right outcome, so the route and the
  // runtime contradicted each other in writing.
  it("is not held for writing nothing when the route says the work is conditional", () => {
    expect(changedNothing(wroteNothing({ conditional: true }))).toBe(false);
  });

  // Absence means unchanged: every stage in existence predates the field.
  it("is still held when the route says nothing", () => {
    expect(changedNothing(wroteNothing())).toBe(true);
  });

  // The declaration supplies a missing precondition; it does not switch off the check
  // for a stage that genuinely wrote something either way.
  it("does not change a stage that did write files", () => {
    const wrote = wroteNothing({
      conditional: true,
      subtasks: [
        {
          id: "rework-1",
          title: "Rework",
          prompt: "p",
          status: "done",
          startedAt: "2026-09-02T00:00:00.000Z",
          activity: { pathsWritten: ["a.cs"] },
        },
      ],
    });
    expect(changedNothing(wrote)).toBe(false);
  });
});
describe("correctionChangedNothing — a shell-only run is unmeasured", () => {
  // The live failure: a correction fixed the code with `printf`/`cat >>`, recorded no
  // written paths, and the runner withdrew the downstream cascade — putting the code
  // review that would have checked the fix back to `passed`.
  it("does not fire when the run could only have written through the shell", () => {
    const subtask = {
      id: "s1",
      brief: "b",
      status: "done",
      correction: { finding: "f", at: "2026-09-03T00:00:00.000Z" },
      activity: { pathsWritten: [], toolCounts: { Bash: 61 } },
    } as unknown as Subtask;
    expect(correctionChangedNothing(subtask)).toBe(false);
  });

  it("does not fire for PowerShell either", () => {
    const subtask = {
      id: "s1",
      brief: "b",
      status: "done",
      correction: { finding: "f", at: "2026-09-03T00:00:00.000Z" },
      activity: { pathsWritten: [], toolCounts: { PowerShell: 6 } },
    } as unknown as Subtask;
    expect(correctionChangedNothing(subtask)).toBe(false);
  });

  // The case the check exists for: a correction that argued in prose and touched
  // nothing by any route. Excusing this would switch it off entirely.
  it("still fires on a correction that used no shell at all", () => {
    const subtask = {
      id: "s1",
      brief: "b",
      status: "done",
      correction: { finding: "f", at: "2026-09-03T00:00:00.000Z" },
      activity: { pathsWritten: [], toolCounts: { Read: 4, Grep: 2 } },
    } as unknown as Subtask;
    expect(correctionChangedNothing(subtask)).toBe(true);
  });
});
