import { describe, expect, it } from "vitest";
import {
  nextAction,
  outstandingPullRequests,
  recordPullRequests,
  settlePullRequest,
} from "./pipelineEngine";
import { TaskPipeline, TaskStage } from "./taskPipeline";

const URL =
  "https://bitbucket.org/QubeDataDevelopment/qubeautoapp/pull-requests/new" +
  "?source=promote/nmgb-2533-navigator-uat-002&dest=UAT";

function stage(over: Partial<TaskStage>): TaskStage {
  return {
    id: "s",
    name: "Stage",
    kind: "implementation",
    status: "pending",
    subtasks: [],
    ...over,
  } as TaskStage;
}

function pipeline(stages: TaskStage[], over: Partial<TaskPipeline> = {}): TaskPipeline {
  return { routeId: "r", stages, ...over } as TaskPipeline;
}

describe("recordPullRequests", () => {
  it("records the branches the link names", () => {
    const result = recordPullRequests(pipeline([]), "ec-uat-promote", [URL], "t0");
    expect(result.pullRequests).toEqual([
      {
        url: URL,
        stageId: "ec-uat-promote",
        at: "t0",
        source: "promote/nmgb-2533-navigator-uat-002",
        target: "UAT",
      },
    ]);
  });

  // A corrected stage reports the same link again, and a split stage reports it from
  // whichever subtask pushed. Neither is a second thing to wait for.
  it("does not record the same link twice", () => {
    const once = recordPullRequests(pipeline([]), "s", [URL], "t0");
    const twice = recordPullRequests(once, "s", [URL], "t1");
    expect(twice).toBe(once);
    expect(twice.pullRequests).toHaveLength(1);
  });

  it("leaves the pipeline untouched when a stage reported none", () => {
    const before = pipeline([]);
    expect(recordPullRequests(before, "s", [], "t0")).toBe(before);
  });
});

describe("outstandingPullRequests", () => {
  // Keyed on the raising stage having resolved, exactly as deferrals are: while it is
  // still running or being corrected, the link may name a branch its next round
  // replaces, and holding the route would stop a stage waiting for itself.
  it("ignores a wait whose stage has not resolved", () => {
    const p = recordPullRequests(
      pipeline([stage({ id: "promote", status: "active" })]),
      "promote",
      [URL],
      "t0",
    );
    expect(outstandingPullRequests(p)).toEqual([]);
  });

  it("counts a wait once its stage has passed", () => {
    const p = recordPullRequests(
      pipeline([stage({ id: "promote", status: "passed" })]),
      "promote",
      [URL],
      "t0",
    );
    expect(outstandingPullRequests(p)).toHaveLength(1);
  });

  it("drops it once merged", () => {
    const p = recordPullRequests(
      pipeline([stage({ id: "promote", status: "passed" })]),
      "promote",
      [URL],
      "t0",
    );
    expect(outstandingPullRequests(settlePullRequest(p, URL, "t1"))).toEqual([]);
  });
});

describe("settlePullRequest", () => {
  // `mergedAt` is when the merge was first *seen*, and a later sweep overwriting it
  // would move the end of a wait the gate measurements read.
  it("keeps the first answer", () => {
    const p = recordPullRequests(pipeline([]), "s", [URL], "t0");
    const first = settlePullRequest(p, URL, "t1");
    const again = settlePullRequest(first, URL, "t2");
    expect(again).toBe(first);
    expect(first.pullRequests?.[0].mergedAt).toBe("t1");
  });

  it("ignores a url it does not know", () => {
    const p = recordPullRequests(pipeline([]), "s", [URL], "t0");
    expect(settlePullRequest(p, "https://elsewhere/pr/1", "t1")).toBe(p);
  });
});

describe("nextAction with an unmerged pull request", () => {
  const promoted = () =>
    recordPullRequests(
      pipeline([
        stage({ id: "promote", name: "Promote to UAT", status: "passed" }),
        stage({ id: "accept", name: "UAT user acceptance", status: "pending" }),
      ]),
      "promote",
      [URL],
      "t0",
    );

  // The failure this state exists for. Without it, the acceptance stage ran and its
  // check reported `4 of 12 commit(s) for NMGB-2533 are not on origin/UAT` -- true,
  // misleading, and several stages removed from what to do about it.
  it("holds the next stage instead of letting its check fail", () => {
    const action = nextAction(promoted());
    expect(action.kind).toBe("pullRequestOpen");
    if (action.kind === "pullRequestOpen") {
      expect(action.stage.id).toBe("accept");
      expect(action.waits).toHaveLength(1);
    }
  });

  it("carries on once the pull request is merged", () => {
    const action = nextAction(settlePullRequest(promoted(), URL, "t1"));
    expect(action.kind).not.toBe("pullRequestOpen");
  });

  // Of every stage, not only one that ships -- the opposite of the deferral rule, and
  // deliberately: an unmerged promotion means the target does not have the work, so any
  // stage that reads the target is about to conclude something from a state that has
  // not arrived.
  it("holds a review as readily as a deployment", () => {
    const p = recordPullRequests(
      pipeline([
        stage({ id: "promote", status: "passed" }),
        stage({ id: "review", kind: "codeReview", status: "pending" }),
      ]),
      "promote",
      [URL],
      "t0",
    );
    expect(nextAction(p).kind).toBe("pullRequestOpen");
  });

  // A failed stage still wins: it is checked before this, because a broken route is the
  // operator's whatever the task is nominally waiting on.
  it("does not mask a failed stage", () => {
    const p = recordPullRequests(
      pipeline([
        stage({ id: "promote", status: "passed" }),
        stage({ id: "broken", status: "failed" }),
      ]),
      "promote",
      [URL],
      "t0",
    );
    expect(nextAction(p).kind).toBe("blocked");
  });
});
