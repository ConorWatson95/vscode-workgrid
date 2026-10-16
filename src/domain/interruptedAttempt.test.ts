import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_CHARS,
  MAX_INTERRUPTED_COMMANDS,
  interruptedAttemptNote,
  recordInterruptedAttempt,
} from "./interruptedAttempt";
import { TaskPipeline } from "./taskPipeline";

const OVERLOADED = "API Error: 529 Overloaded.\nThis is a server-side issue.";

describe("interruptedAttemptNote", () => {
  it("says nothing when the dead attempt ran no commands", () => {
    // Most outages land before any tool call; a note on each would be noise.
    expect(interruptedAttemptNote("Promote", OVERLOADED, [])).toBeUndefined();
    expect(interruptedAttemptNote("Promote", OVERLOADED, ["  ", ""])).toBeUndefined();
  });

  it("quotes the commands and tells the retry to check before repeating", () => {
    const note = interruptedAttemptNote("Promote", OVERLOADED, [
      "git cherry-pick abc123",
      "git push origin promote/x",
    ])!;
    expect(note).toContain("- `git cherry-pick abc123`");
    expect(note).toContain("- `git push origin promote/x`");
    expect(note).toContain("check whether it already took effect");
    // The first line of the cause only: the rest is the CLI's boilerplate.
    expect(note).toContain("(API Error: 529 Overloaded.)");
    expect(note).not.toContain("server-side");
  });

  it("keeps the newest commands and announces the ones it dropped", () => {
    const commands = Array.from({ length: MAX_INTERRUPTED_COMMANDS + 5 }, (_, i) => `step ${i}`);
    const note = interruptedAttemptNote("Build", OVERLOADED, commands)!;
    expect(note).toContain("5 earlier command(s) not shown");
    expect(note).not.toContain("`step 4`");
    expect(note).toContain("`step 5`");
    expect(note).toContain(`\`step ${MAX_INTERRUPTED_COMMANDS + 4}\``);
  });

  it("cuts a long command and says so", () => {
    const long = "x".repeat(MAX_COMMAND_CHARS + 50);
    const note = interruptedAttemptNote("Build", OVERLOADED, [long])!;
    expect(note).toContain(`\`${"x".repeat(MAX_COMMAND_CHARS)}\` … (cut)`);
    expect(note).not.toContain("x".repeat(MAX_COMMAND_CHARS + 1));
  });
});

describe("recordInterruptedAttempt", () => {
  const pipeline = { routeId: "r", routeLabel: "R", stages: [] } as unknown as TaskPipeline;

  it("files the note as guidance scoped to the stage", () => {
    const next = recordInterruptedAttempt(
      pipeline,
      { id: "promote", name: "Promote to UAT" },
      "promote-1",
      "note",
      "2026-10-16T10:00:00.000Z",
    );
    expect(next.guidance).toEqual([
      {
        id: "interrupted-promote-1-2026-10-16T10:00:00.000Z",
        stageId: "promote",
        stageName: "Promote to UAT",
        text: "note",
        at: "2026-10-16T10:00:00.000Z",
        scope: "stage",
      },
    ]);
    expect(pipeline.guidance).toBeUndefined();
  });

  it("returns the pipeline untouched when there is no note", () => {
    expect(recordInterruptedAttempt(pipeline, { id: "s", name: "S" }, "s-1", undefined, "t")).toBe(
      pipeline,
    );
  });
});
