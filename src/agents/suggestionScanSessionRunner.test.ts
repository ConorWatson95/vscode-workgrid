import { describe, expect, it } from "vitest";
import { TaskWorkspace } from "../domain/taskWorkspace";
import {
  createScanTask,
  SCAN_DISALLOWED_TOOLS,
  SCAN_TASK_ID,
  SCAN_TIMEOUT_MS,
  SuggestionScanSessionRunner,
} from "./suggestionScanSessionRunner";

const clock = { now: () => "2026-08-13T09:00:00.000Z" };

class FakeRunner {
  calls: {
    task: TaskWorkspace;
    prompt: string;
    label: string;
    servers?: readonly string[];
    model?: string;
  }[] = [];
  async run(
    task: TaskWorkspace,
    prompt: string,
    label: string,
    options?: { requiredMcpServers?: readonly string[]; model?: string },
  ) {
    this.calls.push({
      task,
      prompt,
      label,
      servers: options?.requiredMcpServers,
      model: options?.model,
    });
    return { ok: true, text: "SUGGESTION: NMGB-1 | Blocker | open | Thing" };
  }
}

describe("createScanTask", () => {
  it("roots the session at the repository, not a worktree", () => {
    // A scan reads a ticket board; running inside a worktree would make what it can
    // see depend on which task happened to be checked out.
    const task = createScanTask("C:/Dev/qubeautoapp", clock.now());
    expect(task.worktreePath).toBe("C:/Dev/qubeautoapp");
    expect(task.repositoryRoot).toBe("C:/Dev/qubeautoapp");
  });

  it("uses one fixed id, so two scans cannot run at once", () => {
    expect(createScanTask("/a", clock.now()).id).toBe(SCAN_TASK_ID);
    expect(createScanTask("/b", clock.now()).id).toBe(SCAN_TASK_ID);
  });
});

describe("SuggestionScanSessionRunner", () => {
  it("passes the prompt, label and required servers through", async () => {
    const inner = new FakeRunner();
    const runner = new SuggestionScanSessionRunner(inner, clock);

    const result = await runner.run("/repo", "Find work", "scan:jira", {
      requiredMcpServers: ["atlassian"],
    });

    expect(result.ok).toBe(true);
    expect(inner.calls[0].prompt).toBe("Find work");
    expect(inner.calls[0].label).toBe("scan:jira");
    expect(inner.calls[0].servers).toEqual(["atlassian"]);
    expect(inner.calls[0].task.worktreePath).toBe("/repo");
  });
});

describe("scan session limits", () => {
  it("removes every tool that could change something", () => {
    for (const tool of ["Bash", "Write", "Edit", "NotebookEdit", "Task"]) {
      expect(SCAN_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it("leaves reading available", () => {
    // A scan may reasonably look at the repository to say something useful about an
    // item, and reading cannot change anything.
    expect(SCAN_DISALLOWED_TOOLS).not.toContain("Read");
    expect(SCAN_DISALLOWED_TOOLS).not.toContain("Glob");
    expect(SCAN_DISALLOWED_TOOLS).not.toContain("Grep");
  });

  it("stops far sooner than a stage does", () => {
    // Somebody is waiting on a list refresh; failing says so where hanging does not.
    expect(SCAN_TIMEOUT_MS).toBeLessThan(15 * 60 * 1000);
    expect(SCAN_TIMEOUT_MS).toBeGreaterThan(60 * 1000);
  });
});

describe("a source's model reaches the session", () => {
  it("passes the model through untouched", async () => {
    const inner = new FakeRunner();
    await new SuggestionScanSessionRunner(inner, clock).run("/repo", "p", "scan:jira", {
      model: "sonnet",
    });
    expect(inner.calls[0].model).toBe("sonnet");
  });
});
