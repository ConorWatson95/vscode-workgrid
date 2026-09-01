import { describe, expect, it } from "vitest";
import { Subtask, TaskStage } from "./taskPipeline";
import { roundHeading, stageRounds, summariseStageHistory } from "./stageHistory";

const subtask = (over: Partial<Subtask> = {}): Subtask =>
  ({ id: "s-1", title: "Run", prompt: "do it", status: "done", ...over }) as Subtask;

const stage = (subtasks: Subtask[], status: TaskStage["status"] = "passed"): TaskStage =>
  ({ id: "st", name: "Implement", kind: "implement", status, intent: "i", subtasks }) as TaskStage;

const correction = (n: number, finding: string): Subtask =>
  subtask({ id: `c-${n}`, title: `Correction ${n}`, correction: { finding, at: "2026-08-18T09:00:00Z" } });

const amendment = (upstream: string): Subtask =>
  subtask({
    id: "a-1",
    title: `Amend for "${upstream}"`,
    correction: {
      finding: "boilerplate the amendment prompt composed",
      at: "2026-08-18T10:00:00Z",
      upstream: { stageId: "up", stageName: upstream },
    },
  });

describe("stageRounds", () => {
  it("classifies a run, a correction and an amendment, numbering each kind from one", () => {
    const rounds = stageRounds(
      stage([subtask(), correction(1, "wrong join"), correction(2, "wrong cast"), amendment("Plan")]),
    );
    expect(rounds.map((r) => [r.kind, r.ordinal])).toEqual([
      ["run", 1],
      ["correction", 1],
      ["correction", 2],
      ["amendment", 1],
    ]);
  });

  it("marks only the newest round of a repaired stage as the one that stands", () => {
    const rounds = stageRounds(stage([subtask(), correction(1, "wrong join")]));
    expect(rounds.map((r) => r.latest)).toEqual([false, true]);
  });

  it("marks no round of a split stage, because parallel units are one round of work", () => {
    const units = stage([subtask({ id: "u-1" }), subtask({ id: "u-2" }), subtask({ id: "u-3" })]);
    expect(stageRounds(units).every((r) => !r.latest)).toBe(true);
  });

  it("headlines a correction's finding and leaves an amendment's composed prompt alone", () => {
    const long = `${"the sales CTE double-counts every purchase line. ".repeat(6)}Fix it.`;
    const [, fix, amend] = stageRounds(stage([subtask(), correction(1, long), amendment("Plan")]));
    expect(fix.finding!.length).toBeLessThan(long.length);
    expect(fix.finding).toContain("double-counts");
    expect(amend.finding).toBeUndefined();
    expect(amend.upstreamStageName).toBe("Plan");
  });
});

describe("summariseStageHistory", () => {
  it("says nothing about a stage that simply ran, split or not", () => {
    expect(summariseStageHistory(stage([subtask()]))).toBeUndefined();
    expect(summariseStageHistory(stage([subtask({ id: "a" }), subtask({ id: "b" })]))).toBeUndefined();
  });

  it("counts corrections, and names the stage an amendment answers", () => {
    const summary = summariseStageHistory(
      stage([subtask(), correction(1, "a"), correction(2, "b"), amendment("Plan")]),
    )!;
    expect(summary).toContain("2 corrections");
    expect(summary).toContain('1 amendment after "Plan" changed');
    expect(summary).toContain("stands");
  });

  it("does not name the same upstream stage twice for two amendments of one correction", () => {
    const summary = summariseStageHistory(
      stage([subtask(), amendment("Plan"), { ...amendment("Plan"), id: "a-2" }]),
    )!;
    expect(summary).toContain("2 amendments");
    expect(summary.match(/"Plan"/g)).toHaveLength(1);
  });
});

describe("roundHeading", () => {
  it("names what a correction was asked to fix", () => {
    const [, fix] = stageRounds(stage([subtask(), correction(1, "the sales CTE double-counts")]));
    expect(roundHeading(fix, true)).toBe(
      "Correction 1 — asked to fix: the sales CTE double-counts",
    );
  });

  it("says an amendment answers another stage, not this one's own error", () => {
    const [, amend] = stageRounds(stage([subtask(), amendment("Plan")]));
    expect(roundHeading(amend, true)).toContain('after "Plan" was corrected');
  });

  it("gives an unsplit, uncorrected run no heading of its own", () => {
    const [only] = stageRounds(stage([subtask()]));
    expect(roundHeading(only, false)).toBeUndefined();
  });
});

describe("a reverify round", () => {
  // A reverify uses the amendment machinery, so it must not inherit the amendment's
  // wording: that says the stage named was corrected, and here it was not -- it found
  // *this* stage stale, which is the opposite claim about both of them.
  const reverified = {
    id: "preview",
    name: "Preview the DEV deployment",
    kind: "test" as const,
    status: "pending" as const,
    intent: "Preview it.",
    splittable: false,
    requiresApproval: false,
    subtasks: [
      { id: "preview-1", title: "Preview", prompt: "p", status: "done" as const, reply: "ok" },
      {
        id: "preview-fix-1",
        title: "Reverify for SQL object review",
        prompt: "p",
        status: "pending" as const,
        correction: {
          finding: "ec-preview.md predates the current deploy/001",
          at: "2026-09-01T00:00:00.000Z",
          upstream: {
            stageId: "review",
            stageName: "SQL object review",
            findings: ["ec-preview.md predates the current deploy/001"],
            reverify: true,
          },
        },
      },
    ],
  };

  it("says the output went stale, never that anything was corrected", () => {
    const round = stageRounds(reverified)[1];
    expect(round.kind).toBe("amendment");
    const heading = roundHeading(round, true);
    expect(heading).toContain("found its output stale");
    expect(heading).not.toContain("was corrected");
  });

  it("counts as a re-run in the summary, not as an amendment", () => {
    const summary = summariseStageHistory(reverified) ?? "";
    expect(summary).toContain('1 re-run after "SQL object review" found it stale');
    expect(summary).not.toContain("amendment");
  });
});
