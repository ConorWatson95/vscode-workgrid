import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  ClaudeStageSessionRunner,
  StageSession,
  StageSessions,
} from "./stageSessionRunner";
import { StreamSessionOptions } from "./claudeStreamSession";
import { ChatItem } from "./streamJson";
import { TaskWorkspace } from "../domain/taskWorkspace";

const TASK = { id: "t1", name: "Fix dealer mapping" } as TaskWorkspace;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

/** A session whose status transitions the test drives by hand. */
class FakeSession extends EventEmitter implements StageSession {
  items: ChatItem[] = [];
  sessionId = "sess-1";
  lastTurnErrored = false;

  reply(text: string): void {
    this.items.push({ kind: "assistant", text });
  }

  settle(status: string): void {
    this.emit("status", status);
  }
}

class FakeSessions implements StageSessions {
  readonly created: {
    taskId: string;
    options: Omit<StreamSessionOptions, "command">;
    prompt?: string;
  }[] = [];
  readonly stopped: string[] = [];
  session = new FakeSession();

  create(
    taskId: string,
    options: Omit<StreamSessionOptions, "command">,
    initialPrompt?: string,
  ): StageSession {
    this.created.push({ taskId, options, prompt: initialPrompt });
    return this.session;
  }

  stop(taskId: string): void {
    this.stopped.push(taskId);
  }
}

function runner(sessions: FakeSessions, timeoutMs = 1000) {
  return new ClaudeStageSessionRunner(
    sessions,
    () => ({ cwd: "/repo", autoCompactThreshold: 160_000, model: "opus" }) as Omit<
      StreamSessionOptions,
      "command"
    >,
    silentLogger,
    timeoutMs,
  );
}

describe("ClaudeStageSessionRunner", () => {
  it("disables auto-compaction, which can never help a single-turn session", () => {
    // Our compaction runs when a turn settles. A subtask is one turn, so the
    // only compaction it could trigger is on a session already finished with —
    // which cost a wasted model turn per subtask on a real route.
    const sessions = new FakeSessions();
    void runner(sessions).run(TASK, "do the thing", "stage:sub-1");

    expect(sessions.created[0].options.autoCompactThreshold).toBe(0);
  });

  describe("per-stage model", () => {
    it("overrides the configured model when the stage names one", () => {
      // Around 80% of a planning stage's wall clock is model time, so this is
      // the dial that moves it — without touching the stages that write code.
      const sessions = new FakeSessions();
      void runner(sessions).run(TASK, "p", "stage:sub-1", { model: "sonnet" });
      expect(sessions.created[0].options.model).toBe("sonnet");
    });

    it("keeps the configured model when the stage names none", () => {
      const sessions = new FakeSessions();
      void runner(sessions).run(TASK, "p", "stage:sub-1");
      expect(sessions.created[0].options.model).toBe("opus");
    });

    it("treats a blank override as no override, not as clearing the model", () => {
      const sessions = new FakeSessions();
      void runner(sessions).run(TASK, "p", "stage:sub-1", { model: "   " });
      expect(sessions.created[0].options.model).toBe("opus");
    });
  });

  it("passes the prompt through and starts a fresh session per subtask", () => {
    const sessions = new FakeSessions();
    void runner(sessions).run(TASK, "do the thing", "stage:sub-1");

    expect(sessions.created).toHaveLength(1);
    expect(sessions.created[0]).toMatchObject({ taskId: "t1", prompt: "do the thing" });
  });

  it("resolves with the last assistant reply once the turn settles", async () => {
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1");

    sessions.session.reply("first");
    sessions.session.reply("Done — added the mapping.");
    sessions.session.settle("waiting");

    await expect(promise).resolves.toMatchObject({
      ok: true,
      text: "Done — added the mapping.",
      sessionId: "sess-1",
    });
  });

  it("reports failure when the turn errored", async () => {
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1");

    sessions.session.lastTurnErrored = true;
    sessions.session.reply("partial");
    sessions.session.settle("waiting");

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("error");
  });

  it("treats a stopped session with a reply as usable, and an empty one as failed", async () => {
    const withReply = new FakeSessions();
    const a = runner(withReply).run(TASK, "p", "stage:sub-1");
    withReply.session.reply("here is the plan");
    withReply.session.settle("stopped");
    await expect(a).resolves.toMatchObject({ ok: true, text: "here is the plan" });

    const empty = new FakeSessions();
    const b = runner(empty).run(TASK, "p", "stage:sub-1");
    empty.session.settle("stopped");
    await expect(b).resolves.toMatchObject({ ok: false });
  });

  it("fails a session that died", async () => {
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1");
    sessions.session.settle("failed");

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed");
  });

  it("stops a hung session and resolves, so one subtask cannot stall the route", async () => {
    const sessions = new FakeSessions();
    const result = await runner(sessions, 5).run(TASK, "p", "stage:sub-1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(sessions.stopped).toEqual(["t1"]);
  });

  it("keeps what a timed-out stage produced, rather than discarding it", async () => {
    // The stage still fails, but tens of minutes of investigation used to be
    // thrown away, leaving nothing to diagnose the timeout from.
    const sessions = new FakeSessions();
    sessions.session.reply("Found the root cause in the overnight proc.");
    const result = await runner(sessions, 5).run(TASK, "p", "stage:sub-1");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("root cause");
  });

  it("ignores status changes after settling, so the result is not overwritten", async () => {
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1");

    sessions.session.reply("the real answer");
    sessions.session.settle("waiting");
    sessions.session.settle("failed");

    await expect(promise).resolves.toMatchObject({ ok: true, text: "the real answer" });
  });
});
