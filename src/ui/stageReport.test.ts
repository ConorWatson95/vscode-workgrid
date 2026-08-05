import { describe, expect, it } from "vitest";
import { formatStageReport, formatTaskReport, withLiveActivity } from "./stageReport";
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

describe("formatTaskReport", () => {
  it("reports stages that ran and merely lists those that have not", () => {
    // A report mostly made of "pending" hides the part worth reading.
    const untouched = stage({ id: "sc-verify", name: "Verify", status: "pending", subtasks: [] });
    const report = formatTaskReport("NMGB-2792", pipeline([stage(), untouched]));
    expect(report).toContain("Resolved SQL files: 2");
    expect(report).toContain("## Not yet run");
    expect(report).toContain("Verify (pending)");
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
