import { describe, expect, it } from "vitest";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { SuggestionSource } from "../domain/suggestionSourceFile";
import { ExternalFeedbackService } from "./externalFeedbackService";
import { CommandOutcome } from "./verificationRunner";

const ROOT = "C:/repo";
const WAIT = "2026-10-07T12:00:00.000Z";

function task(overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    id: "t1",
    name: "Pyramid",
    repositoryRoot: ROOT,
    worktreePath: "C:/wt/t1",
    branchName: "b",
    baseBranch: "DEV",
    status: "ready",
    createdAt: "",
    updatedAt: "",
    origin: { sourceId: "jira", ref: "NMGB-1", at: "" },
    ...overrides,
  } as TaskWorkspace;
}

const source = {
  id: "jira",
  label: "JIRA",
  scanPrompt: "",
  feedbackCommand: "feedback ${ref} ${since}",
  order: { ranks: [] },
} as SuggestionSource;

function setup(output: CommandOutcome, waiting = true) {
  const repository = new InMemoryTaskRepository();
  const commands: string[] = [];
  const service = new ExternalFeedbackService({
    repository,
    runner: {
      run: async (command) => {
        commands.push(command);
        return output;
      },
    },
    sources: () => [source],
    waitingSince: () => (waiting ? WAIT : undefined),
    clock: { now: () => "2026-10-08T12:00:00.000Z" },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  return { repository, service, commands };
}

const reply = (created: string): CommandOutcome => ({
  exitCode: 0,
  output: JSON.stringify({ comments: [{ author: "Tess", created, body: "still wrong" }] }),
});

describe("ExternalFeedbackService", () => {
  it("records a comment newer than the wait and reports it as arrived", async () => {
    const { repository, service, commands } = setup(reply("2026-10-08T09:00:00.000Z"));
    await repository.save(task());
    const outcome = await service.poll(ROOT);
    expect(commands).toEqual([`feedback NMGB-1 ${WAIT}`]);
    expect(outcome.arrived).toHaveLength(1);
    expect((await repository.get("t1"))?.externalFeedback?.latest?.author).toBe("Tess");
  });

  it("does not poll a task that is not waiting on others", async () => {
    const { repository, service, commands } = setup(reply("2026-10-08T09:00:00.000Z"), false);
    await repository.save(task());
    await service.poll(ROOT);
    expect(commands).toEqual([]);
  });

  it("records nothing when the command fails, rather than a quiet ticket", async () => {
    const { repository, service } = setup({ exitCode: 1, output: "401" });
    await repository.save(task());
    const outcome = await service.poll(ROOT);
    expect(outcome.arrived).toEqual([]);
    expect((await repository.get("t1"))?.externalFeedback).toBeUndefined();
  });

  it("polls from the read time once marked read", async () => {
    const { repository, service, commands } = setup(reply("2026-10-08T09:00:00.000Z"));
    await repository.save(task());
    await service.poll(ROOT);
    await service.markRead("t1");
    const outcome = await service.poll(ROOT);
    expect(commands[1]).toBe("feedback NMGB-1 2026-10-08T12:00:00.000Z");
    // The same comment again is not new.
    expect(outcome.arrived).toEqual([]);
  });
});
