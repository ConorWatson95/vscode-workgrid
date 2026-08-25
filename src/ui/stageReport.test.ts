import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_CHARS,
  formatGateWaitLine,
  formatStageReport,
  formatTaskReport,
  withLiveActivity,
} from "./stageReport";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "sc-deploy-dev-preview",
    name: "Preview the deployment",
    kind: "implement",
    status: "passed",
    intent: "Run the deployment with -WhatIf.",
    splittable: false,
    requiresApproval: true,
    subtasks: [
      {
        id: "p-1",
        title: "Preview",
        prompt: "Run it.",
        status: "done",
        startedAt: "2026-08-04T10:00:00Z",
        finishedAt: "2026-08-04T10:04:00Z",
        sessionId: "sess-1",
        reply: "It would change 2 objects.",
        activity: {
          toolCounts: { PowerShell: 1, Read: 3 },
          commands: ["./tools/sql/Invoke-SqlDeployment.ps1 -WhatIf"],
          pathsWritten: [],
          pathsRead: ["docs/sql.md"],
          output: "$ ./tools/sql/Invoke-SqlDeployment.ps1 -WhatIf\nResolved SQL files: 2",
        },
      },
    ],
    ...overrides,
  } as TaskStage;
}

const pipeline = (stages: TaskStage[], guidance?: TaskPipeline["guidance"]) =>
  ({ routeId: "sql-change", routeLabel: "SQL change", stages, guidance }) as TaskPipeline;

describe("usage in the report", () => {
  const measured = (over: Record<string, unknown> = {}) =>
    stage({
      subtasks: [
        {
          id: "p-1",
          title: "Preview",
          prompt: "Run it.",
          status: "done",
          startedAt: "2026-08-04T10:00:00Z",
          finishedAt: "2026-08-04T10:04:00Z",
          activity: {
            costUsd: 0.4213,
            tokens: { input: 12_000, output: 4500, cacheRead: 88_000, cacheCreation: 300 },
          },
          ...over,
        },
      ],
    } as Partial<TaskStage>);

  it("puts the cost in the header, not under the command output", () => {
    const report = formatStageReport("Task", measured(), undefined);
    const header = report.slice(0, report.indexOf("## "));
    expect(header).toContain("$0.4213");
    expect(header).toContain("4m in session");
    expect(header).toContain("out");
  });

  it("names the cached share, which is the point of a fresh session per subtask", () => {
    // 88k of 100.3k input served from cache.
    expect(formatStageReport("Task", measured(), undefined)).toContain("88.0k cached, 88%");
  });

  it("says when a total is partial rather than showing a small number", () => {
    const partial = stage({
      subtasks: [
        ...measured().subtasks,
        {
          id: "p-2",
          title: "Older",
          prompt: "…",
          status: "done",
          activity: { toolCounts: { Read: 1 } },
        },
      ],
    } as Partial<TaskStage>);
    expect(formatStageReport("Task", partial, undefined)).toContain(
      "1 subtask(s) reported no usage",
    );
  });

  it("shows nothing at all when there is not even a duration", () => {
    const bare = stage({
      subtasks: [{ id: "p-1", title: "Preview", prompt: "…", status: "done" }],
    } as Partial<TaskStage>);
    expect(formatStageReport("Task", bare, undefined)).not.toContain("**Cost:**");
  });

  it("still reports elapsed time for a stage that ran before cost was recorded", () => {
    // And does not call it a partial *total* — there is no total, only a duration,
    // and the two invite different comparisons.
    const report = formatStageReport("Task", stage(), undefined);
    expect(report).toContain("4m in session");
    expect(report).toContain("no cost was recorded for 1 subtask(s)");
    expect(report).not.toContain("partial");
  });

  it("totals the whole route, so work pushed to a later stage is still counted", () => {
    const report = formatTaskReport("Task", pipeline([measured(), measured()]));
    expect(report).toContain("$0.8426");
  });
});

describe("withLiveActivity", () => {
  const running = {
    subtaskId: "p-1",
    activity: {
      toolCounts: { PowerShell: 1 },
      commands: ["dotnet build"],
      pathsWritten: [],
      pathsRead: [],
      output: "Build started…",
    },
  };

  it("shows a running subtask's work in the report", () => {
    const target = stage({
      status: "active",
      subtasks: [{ id: "p-1", title: "Build", prompt: "Build it.", status: "active" }],
    });
    const report = formatStageReport("SC-1", withLiveActivity(target, running), undefined);
    expect(report).toContain("dotnet build");
    expect(report).toContain("Build started…");
    expect(report).not.toContain("No activity was recorded");
  });

  it("leaves the stage alone when nothing is running", () => {
    const target = stage();
    expect(withLiveActivity(target, undefined)).toBe(target);
  });

  it("leaves the stage alone when the live subtask belongs to another stage", () => {
    const target = stage();
    expect(withLiveActivity(target, { ...running, subtaskId: "other" })).toBe(target);
  });

  it("does not mutate the stage it was given", () => {
    const target = stage({
      subtasks: [{ id: "p-1", title: "Build", prompt: "Build it.", status: "active" }],
    });
    withLiveActivity(target, running);
    expect(target.subtasks[0].activity).toBeUndefined();
  });
});

describe("formatStageReport", () => {
  it("shows the command that ran and what it printed", () => {
    // The reported gap: a preview stage produced pages of output and left nothing
    // to look at, so the only way to see it was to run the command again by hand.
    const report = formatStageReport("NMGB-2792", stage(), pipeline([stage()]));
    expect(report).toContain("./tools/sql/Invoke-SqlDeployment.ps1 -WhatIf");
    expect(report).toContain("Resolved SQL files: 2");
  });

  it("reports what the agent said", () => {
    expect(formatStageReport("t", stage(), undefined)).toContain(
      "It would change 2 objects.",
    );
  });

  it("lists the tools it used with counts", () => {
    const report = formatStageReport("t", stage(), undefined);
    expect(report).toMatch(/Read×3/);
    expect(report).toMatch(/PowerShell×1/);
  });

  it("names files changed separately from files read", () => {
    const changed = stage({
      subtasks: [
        {
          id: "p-1",
          title: "Write",
          prompt: "p",
          status: "done",
          activity: {
            toolCounts: { Write: 1 },
            pathsWritten: ["migration/001.sql"],
            pathsRead: ["docs/sql.md"],
          },
        },
      ],
    } as Partial<TaskStage>);
    const report = formatStageReport("t", changed, undefined);
    expect(report).toContain("### Files changed");
    expect(report).toContain("migration/001.sql");
    expect(report).toContain("Files read (1)");
  });

  it("says so when a subtask has no recorded activity", () => {
    // An empty section reads as "it did nothing", when the truth is that this ran
    // before activity was kept.
    const old = stage({
      subtasks: [{ id: "p-1", title: "Old", prompt: "p", status: "done" }],
    } as Partial<TaskStage>);
    expect(formatStageReport("t", old, undefined)).toContain(
      "No activity was recorded",
    );
  });

  it("includes the guidance given when approving this stage", () => {
    const withNote = pipeline([stage()], [
      {
        id: "g1",
        stageId: "sc-deploy-dev-preview",
        stageName: "Preview",
        text: "Only this ticket's project, with -Project.",
        at: "2026-08-04T10:05:00Z",
      },
    ]);
    const report = formatStageReport("t", stage(), withNote);
    expect(report).toContain("Only this ticket's project, with -Project.");
  });

  it("omits guidance given at a different stage", () => {
    const elsewhere = pipeline([stage()], [
      { id: "g1", stageId: "other", stageName: "Other", text: "not here", at: "t" },
    ]);
    expect(formatStageReport("t", stage(), elsewhere)).not.toContain("not here");
  });

  it("shows a failure reason prominently", () => {
    const failed = stage({
      status: "failed",
      subtasks: [
        {
          id: "p-1",
          title: "Preview",
          prompt: "p",
          status: "failed",
          failureReason: "timed out after 45 minute(s)",
          reply: "got partway",
        },
      ],
    } as Partial<TaskStage>);
    const report = formatStageReport("t", failed, undefined);
    expect(report).toContain("timed out after 45 minute(s)");
    // The partial reply is kept: a failed stage is the one you most want to read.
    expect(report).toContain("got partway");
  });

  it("leads with the failure, above the intent", () => {
    // Someone opening the report of a failed stage is asking one question, and
    // the reason used to sit halfway down under the tool counts.
    const failed = stage({
      status: "failed",
      subtasks: [
        { id: "p-1", title: "Review", prompt: "p", status: "failed", failureReason: "error_max_turns" },
      ],
    } as Partial<TaskStage>);
    const report = formatStageReport("t", failed, undefined);
    expect(report.indexOf("Failed")).toBeLessThan(report.indexOf("## Intent"));
    expect(report).toContain("turn budget");
  });

  it("shows the session's own error when no tool ever ran", () => {
    const died = stage({
      status: "failed",
      subtasks: [
        {
          id: "p-1",
          title: "Review",
          prompt: "p",
          status: "failed",
          failureReason: "error_during_execution",
          activity: {
            toolCounts: {},
            commands: [],
            pathsWritten: [],
            pathsRead: [],
            output: "",
            errors: ["Error: MCP server 'atlassian' failed to start"],
          },
        },
      ],
    } as Partial<TaskStage>);
    const report = formatStageReport("t", died, undefined);
    expect(report).toContain("### Session errors");
    expect(report).toContain("MCP server 'atlassian' failed to start");
  });

  it("says a failed session did nothing, rather than that nothing was recorded", () => {
    // The two read identically and mean opposite things: one invites the reader to
    // look for what it did, the other says there is nothing to look for.
    const died = stage({
      status: "failed",
      subtasks: [
        { id: "p-1", title: "Review", prompt: "p", status: "failed", failureReason: "boom" },
      ],
    } as Partial<TaskStage>);
    const report = formatStageReport("t", died, undefined);
    expect(report).toContain("without calling a single tool");
    expect(report).not.toContain("No activity was recorded");
  });

  it("handles a stage that has not run yet", () => {
    const pending = stage({ status: "pending", subtasks: [] });
    expect(formatStageReport("t", pending, undefined)).toContain("no subtasks yet");
  });
});

describe("gate wait in the report", () => {
  const NOW = Date.parse("2026-08-13T12:00:00.000Z");
  const gate = (over: Partial<TaskStage> = {}) =>
    stage({
      id: "signoff",
      name: "Human sign-off on the DEV site",
      kind: "humanVerification",
      requiresApproval: true,
      subtasks: [],
      ...over,
    });

  it("names whose wait it was, so calendar time is accountable", () => {
    const p = {
      ...pipeline([
        gate({
          id: "signoff",
          checklistAudience: "others",
          status: "passed",
          finishedAt: "2026-08-11T09:00:00.000Z",
        }),
      ]),
      interventions: [
        { kind: "approval" as const, stageId: "signoff", at: "2026-08-13T11:00:00.000Z" },
      ],
    } as TaskPipeline;
    const line = formatGateWaitLine(p, NOW);
    expect(line).toBe("**Waiting at gates:** 2d 2h with others");
  });

  it("keeps a live wait separate from a finished one", () => {
    const p = pipeline([
      gate({ status: "awaiting-approval", checklistAudience: "others", finishedAt: "2026-08-13T09:00:00.000Z" }),
    ]);
    expect(formatGateWaitLine(p, NOW)).toBe("**Waiting at gates:** 3h still with others");
  });

  it("says nothing when no gate has waited", () => {
    expect(formatGateWaitLine(pipeline([gate({ status: "pending" })]), NOW)).toBeUndefined();
  });

  it("appears in the whole-task report beside the execution total", () => {
    const p = pipeline([
      stage(),
      gate({ status: "awaiting-approval", checklistAudience: "others", finishedAt: "2026-08-13T09:00:00.000Z" }),
    ]);
    expect(formatTaskReport("NMGB-2792", p, NOW)).toContain("still with others");
  });
});

describe("formatTaskReport", () => {
  it("summarises stages that ran and merely lists those that have not", () => {
    // A report mostly made of "pending" hides the part worth reading.
    const untouched = stage({ id: "sc-verify", name: "Verify", status: "pending", subtasks: [] });
    const report = formatTaskReport("NMGB-2792", pipeline([stage(), untouched]));
    expect(report).toContain("## Stages that have run");
    expect(report).toContain("**Preview the deployment** — passed");
    expect(report).toContain("## Not yet run");
    expect(report).toContain("Verify (pending)");
  });

  it("leaves the stage's own output to the stage's own report", () => {
    // It used to embed every stage report in full, which on a real 22-stage route
    // rendered to 394KB of markdown — and VS Code's preview will not open that, so the
    // button that produces it appeared to do nothing at all. Command output is what
    // fills it: capped per subtask, so a stage with three carries three times the cap.
    const report = formatTaskReport("NMGB-2792", pipeline([stage()]));
    expect(report).not.toContain("Resolved SQL files: 2");
    expect(report).toContain("Show What This Did");
  });

  it("never summarises away a stage that says it did not do its work", () => {
    // That is the reader's reason for opening the report in the first place.
    const held = stage({ blocked: "nothing for this ticket is committed anywhere" });
    expect(formatTaskReport("NMGB-2792", pipeline([held]))).toContain(
      "nothing for this ticket is committed anywhere",
    );
  });

  it("says so when the task has no route", () => {
    expect(formatTaskReport("t", undefined)).toContain("no route");
  });
});

describe("credentials", () => {
  const CONNECTION =
    "Server=tcp:qube.database.windows.net;Database=Core;User ID=deploy;Password=S3cr3t!Value";

  it("masks a credential in a command, its output and the reply", () => {
    // All three carry it in practice: the command builds the connection string, the
    // script echoes it back, and the agent quotes what it ran.
    const report = formatStageReport(
      "SC-123",
      stage({
        subtasks: [
          {
            id: "p-1",
            title: "Deploy",
            prompt: "Deploy it.",
            status: "done",
            reply: `I ran it with ${CONNECTION}`,
            activity: {
              toolCounts: { PowerShell: 1 },
              commands: [`./Invoke-SqlDeployment.ps1 -ConnectionString "${CONNECTION}"`],
              pathsWritten: [],
              pathsRead: [],
              output: `connecting with ${CONNECTION}`,
            },
          },
        ],
      }),
      undefined,
    );

    expect(report).not.toContain("S3cr3t!Value");
    // Still useful: the script and the database are what make the report readable.
    expect(report).toContain("Invoke-SqlDeployment.ps1");
    expect(report).toContain("Database=Core");
  });

  it("masks one that reached the state file before redaction existed", () => {
    // Capture-time masking cannot help a task an older build recorded, so the
    // render pass has to catch it too.
    const report = formatStageReport(
      "SC-123",
      stage({ subtasks: [{ id: "p-1", title: "x", prompt: "x", status: "done", reply: CONNECTION }] }),
      undefined,
    );
    expect(report).not.toContain("S3cr3t!Value");
  });
});

describe("reading order", () => {
  it("puts what the agent reported above the commands and output", () => {
    // The reported complaint: "I always find myself scrolling forever". The reply is
    // what the report is opened for and it used to be last, under the tool counts,
    // the file lists, the commands and their output.
    const report = formatStageReport("t", stage(), pipeline([stage()]));
    const reply = report.indexOf("What the agent reported");
    expect(reply).toBeGreaterThan(-1);
    expect(reply).toBeLessThan(report.indexOf("Commands run"));
    expect(reply).toBeLessThan(report.indexOf("### Output"));
    // The intent is the instruction you wrote, not something it found out.
    expect(reply).toBeLessThan(report.indexOf("## Intent"));
  });

  it("collapses the mechanics once the stage has settled", () => {
    const report = formatStageReport("t", stage({ status: "passed" }), undefined);
    expect(report).toContain("<details><summary>What it did");
  });

  it("leaves them open while the stage is still running", () => {
    // Mid-run they are the point: it is how you tell whether it is progressing.
    const report = formatStageReport("t", stage({ status: "active" }), undefined);
    expect(report).not.toContain("<details><summary>What it did");
    expect(report).toContain("## What it did");
  });

  it("leaves them open when the stage failed", () => {
    const failed = stage({
      status: "failed",
      subtasks: [
        {
          id: "p-1",
          title: "Preview",
          prompt: "p",
          status: "failed",
          failureReason: "exit 1",
          reply: "it broke",
          activity: { toolCounts: { PowerShell: 1 }, commands: ["build"], output: "error" },
        },
      ],
    } as Partial<TaskStage>);
    const report = formatStageReport("t", failed, undefined);
    expect(report).not.toContain("<details><summary>What it did");
  });

  it("keeps findings above the reply, being the reason to read it", () => {
    const review = stage({
      kind: "domainReview",
      subtasks: [
        {
          id: "r-1",
          title: "Review",
          prompt: "p",
          status: "done",
          reply: "### Critical: wrong proc\n\nDetail here.",
        },
      ],
    } as Partial<TaskStage>);
    const report = formatStageReport("t", review, undefined);
    expect(report.indexOf("## Findings")).toBeLessThan(
      report.indexOf("What the agent reported"),
    );
  });
});

describe("declared verification", () => {
  it("names the command that decided the outcome", () => {
    // Whether an outcome came from a process or from the agent's word for it is not
    // otherwise visible, and they mean very different things.
    const verified = stage({ verify: "dotnet build -warnaserror" });
    expect(formatStageReport("t", verified, undefined)).toContain(
      "**Verified by:** `dotnet build -warnaserror`",
    );
  });

  it("masks a credential in the command", () => {
    const verified = stage({ verify: 'sqlcmd -S x -U deploy -P S3cr3t!Value -Q "select 1"' });
    const report = formatStageReport("t", verified, undefined);
    expect(report).not.toContain("S3cr3t!Value");
  });
});

describe("a report too large for the preview to open", () => {
  it("truncates at the cap and says so", () => {
    // Announced rather than silent, for the reason the activity watcher announces its
    // own truncation: output that simply stops reads as the command having stopped.
    const huge = stage({
      subtasks: [
        {
          id: "s1",
          title: "Run it",
          prompt: "p",
          status: "done" as const,
          startedAt: "t1",
          finishedAt: "t2",
          activity: { output: "x".repeat(MAX_REPORT_CHARS * 2) },
        },
      ],
    });
    const report = formatStageReport("NMGB-2792", huge, undefined);
    expect(report.length).toBeLessThan(MAX_REPORT_CHARS + 500);
    expect(report).toContain("truncated here");
  });

  it("leaves an ordinary report untouched", () => {
    const report = formatStageReport("NMGB-2792", stage(), undefined);
    expect(report).not.toContain("truncated here");
  });
});

describe("a stage that was corrected", () => {
  const repaired = (status: TaskStage["status"] = "passed") =>
    stage({
      status,
      subtasks: [
        { id: "p-1", title: "Implement", prompt: "do it", status: "done", reply: "Built the grid." },
        {
          id: "c-1",
          title: "Correction 1",
          prompt: "fix it",
          status: "done",
          reply: "Changed the cast.",
          correction: { finding: "the total column is a string", at: "2026-08-18T09:00:00Z" },
        },
        {
          id: "c-2",
          title: "Correction 2",
          prompt: "fix it",
          status: "done",
          reply: "Split the dropdown.",
          correction: { finding: "the comparison dropdown is now two", at: "2026-08-18T11:00:00Z" },
        },
      ],
    } as Partial<TaskStage>);

  it("says how it got to its current state, and which round stands", () => {
    const report = formatStageReport("Scorecard", repaired(), undefined);
    expect(report).toContain("**How it got here:**");
    expect(report).toContain("2 corrections");
    expect(report).toContain("Correction 2 — asked to fix: the comparison dropdown is now two · the version that stands");
  });

  it("names what each correction was asked to fix, which was recorded nowhere before", () => {
    const report = formatStageReport("Scorecard", repaired(), undefined);
    expect(report).toContain("Correction 1 — asked to fix: the total column is a string");
  });

  it("folds a superseded correction away once the stage has settled, but never the round that stands", () => {
    const settled = formatStageReport("Scorecard", repaired("passed"), undefined);
    expect(settled).toContain("<details><summary>Correction 1");
    expect(settled).not.toContain("<details><summary>Correction 2");

    // While it is still being worked on, everything is open: the reader is watching a
    // repair rather than reading a conclusion.
    const live = formatStageReport("Scorecard", repaired("running"), undefined);
    expect(live).not.toContain("<details><summary>Correction 1");
  });

  it("does not repeat 'What the agent reported' once per round", () => {
    const report = formatStageReport("Scorecard", repaired(), undefined);
    expect(report.match(/What the agent reported/g)).toBeNull();
  });

  it("leaves a stage nothing has corrected exactly as it was", () => {
    const report = formatStageReport("Scorecard", stage(), undefined);
    expect(report).not.toContain("How it got here");
    expect(report).toContain("## What the agent reported");
  });
});

describe("a stage repaired many times, held at a gate", () => {
  // Measured on a real gate: ten rounds rendered 60,159 characters and the report was
  // truncated — which loses the end of the standing round, the one part a reader is
  // there for. Folding the replies alone was not enough, because command output is
  // capped per subtask so ten subtasks carry ten times the cap.
  const round = (n: number, latest: boolean) => ({
    id: `review-${n}`,
    title: `Round ${n}`,
    prompt: "p",
    status: "done" as const,
    reply: `Findings, revision ${n}. ` + "x".repeat(4000),
    activity: { commands: ["git diff " + "y".repeat(200)], output: "z".repeat(18000) },
    ...(n > 1
      ? {
          correction: {
            finding: "upstream moved",
            at: "t1",
            upstream: { stageId: "app", stageName: "Implement the application", findings: ["f"] },
          },
        }
      : {}),
    ...(latest ? {} : {}),
  });

  const stage = {
    id: "review", name: "Code review", kind: "codeReview", status: "awaiting-approval",
    intent: "review it", splittable: false, requiresApproval: false,
    subtasks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => round(n, n === 10)),
  } as never;

  const task = { id: "t", name: "T", branch: "b", baseBranch: "main", worktreePath: "/w", status: "ready" } as never;

  it("fits without truncation", () => {
    const md = formatStageReport(task, stage);
    expect(md.length).toBeLessThan(MAX_REPORT_CHARS);
    expect(md).not.toContain("This report was truncated");
  });

  it("keeps the standing round whole, body and mechanics", () => {
    const md = formatStageReport(task, stage);
    expect(md).toContain("Findings, revision 10");
    expect(md).toContain("the version that stands");
    expect(md).toContain("tools, commands and output");
  });

  it("says a folded round is superseded rather than opening on nothing", () => {
    const md = formatStageReport(task, stage);
    expect(md).toContain("<details><summary>");
    expect(md).toContain("Superseded by a later round");
    expect(md).not.toContain("Findings, revision 5");
  });
});
