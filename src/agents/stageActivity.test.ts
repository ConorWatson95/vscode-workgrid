import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_CHARS,
  StageActivityWatcher,
} from "./stageActivity";
import { ChatItem } from "./streamJson";

const tool = (name: string, detail?: string): ChatItem =>
  ({ kind: "tool", name, detail }) as ChatItem;
const result = (text: string, isError = false): ChatItem =>
  ({ kind: "tool-result", text, isError }) as ChatItem;

function watch(items: ChatItem[]) {
  const watcher = new StageActivityWatcher();
  for (const item of items) watcher.observe(item);
  return watcher;
}

describe("StageActivityWatcher", () => {
  it("counts the tools a stage used", () => {
    const activity = watch([
      tool("Read", "a.sql"),
      result("contents"),
      tool("Read", "b.sql"),
      result("contents"),
      tool("Bash", "git status"),
      result("clean"),
    ]).result();
    expect(activity.toolCounts).toEqual({ Read: 2, Bash: 1 });
  });

  it("keeps commands verbatim, so a wrong flag is visible afterwards", () => {
    // The case that prompted this: a deployment ran without -Project and touched
    // every project. Seeing the exact command is what makes that obvious.
    const activity = watch([
      tool("PowerShell", "./tools/sql/Invoke-SqlDeployment.ps1 -WhatIf"),
      result("Resolved SQL files: 251"),
    ]).result();
    expect(activity.commands).toEqual([
      "./tools/sql/Invoke-SqlDeployment.ps1 -WhatIf",
    ]);
  });

  it("separates files written from files read", () => {
    const activity = watch([
      tool("Write", "migration/001.sql"),
      result("ok"),
      tool("Edit", "migration/002.sql"),
      result("ok"),
      tool("Read", "docs/process.md"),
      result("text"),
    ]).result();
    expect(activity.pathsWritten).toEqual([
      "migration/001.sql",
      "migration/002.sql",
    ]);
    expect(activity.pathsRead).toEqual(["docs/process.md"]);
  });

  it("deduplicates repeated calls", () => {
    const activity = watch([
      tool("Bash", "npm test"),
      result("ok"),
      tool("Bash", "npm test"),
      result("ok"),
    ]).result();
    expect(activity.commands).toEqual(["npm test"]);
    expect(activity.toolCounts.Bash).toBe(2);
  });

  it("captures command output with the command that produced it", () => {
    const activity = watch([
      tool("Bash", "ls"),
      result("one\ntwo"),
    ]).result();
    expect(activity.output).toContain("$ ls");
    expect(activity.output).toContain("one\ntwo");
  });

  it("marks a failed command in the output", () => {
    const activity = watch([
      tool("Bash", "npm test"),
      result("1 failing", true),
    ]).result();
    expect(activity.output).toContain("[failed]");
  });

  it("keeps only command output, not file contents", () => {
    // A read's result is recoverable from the repository and would swamp the part
    // worth reading.
    const activity = watch([
      tool("Read", "big.sql"),
      result("thousands of lines of SQL"),
    ]).result();
    expect(activity.output).toBe("");
  });

  it("caps output and says that it did", () => {
    // Persisted in a state file that is rewritten whole, so this has a ceiling —
    // but output that just stops reads as the command having stopped.
    const activity = watch([
      tool("Bash", "cat huge"),
      result("x".repeat(MAX_OUTPUT_CHARS * 2)),
    ]).result();
    expect(activity.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 200);
    expect(activity.output).toMatch(/truncated|omitted/);
  });

  it("stops accumulating once capped rather than growing forever", () => {
    const watcher = watch([
      tool("Bash", "first"),
      result("y".repeat(MAX_OUTPUT_CHARS)),
      tool("Bash", "second"),
      result("z".repeat(MAX_OUTPUT_CHARS)),
    ]);
    expect(watcher.result().output.length).toBeLessThanOrEqual(
      MAX_OUTPUT_CHARS + 200,
    );
  });

  it("reports empty when the stage did nothing worth recording", () => {
    expect(new StageActivityWatcher().isEmpty()).toBe(true);
    expect(watch([tool("Read", "a.sql"), result("x")]).isEmpty()).toBe(false);
  });

  it("attributes a result to the call it followed", () => {
    // Items carry no ids, so the owning call is the most recent tool entry. A
    // read between two commands must not capture the read's contents.
    const activity = watch([
      tool("Bash", "one"),
      result("out-one"),
      tool("Read", "f.txt"),
      result("file body"),
      tool("Bash", "two"),
      result("out-two"),
    ]).result();
    expect(activity.output).toContain("out-one");
    expect(activity.output).toContain("out-two");
    expect(activity.output).not.toContain("file body");
  });
});
