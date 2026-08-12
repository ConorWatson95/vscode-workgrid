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
  lastTurnError?: string;

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

function runner(sessions: FakeSessions, timeoutMs = 1000, logger = silentLogger) {
  return new ClaudeStageSessionRunner(
    sessions,
    () => ({ cwd: "/repo", autoCompactThreshold: 160_000, model: "opus" }) as Omit<
      StreamSessionOptions,
      "command"
    >,
    logger,
    timeoutMs,
  );
}

/** Captures error lines, so what a reader would actually see can be asserted. */
function capturingLogger() {
  const errors: string[] = [];
  return {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: (m: string) => errors.push(m) } as never,
    errors,
  };
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

describe("failure reasons", () => {
  it("reports what the CLI said, not a generic sentence", async () => {
    // "the agent reported an error" was all a reader got: the cause — a turn
    // limit, a rate limit, a spawn failure — sat in a transcript item nobody kept.
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1");

    sessions.session.lastTurnErrored = true;
    sessions.session.lastTurnError = "error_max_turns";
    sessions.session.settle("waiting");

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("error_max_turns");
  });

  it("logs the reason and how far it got, at error level", async () => {
    // The whole failure used to arrive as one info line saying a stage failed.
    // stderr went to debug, which the output channel discards at its default
    // level, so the cause was gone by the time anyone looked.
    const { logger, errors } = capturingLogger();
    const sessions = new FakeSessions();
    const promise = runner(sessions, 1000, logger).run(TASK, "p", "stage:sub-1");

    sessions.session.lastTurnErrored = true;
    sessions.session.lastTurnError = "error_max_turns";
    sessions.session.settle("waiting");
    await promise;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error_max_turns");
    expect(errors[0]).toContain("stage:sub-1");
    expect(errors[0]).toContain("no activity recorded");
  });

  it("says nothing at error level when the stage succeeded", async () => {
    const { logger, errors } = capturingLogger();
    const sessions = new FakeSessions();
    const promise = runner(sessions, 1000, logger).run(TASK, "p", "stage:sub-1");
    sessions.session.reply("done");
    sessions.session.settle("waiting");
    await promise;

    expect(errors).toEqual([]);
  });

  it("falls back to the generic sentence when the CLI said nothing", async () => {
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1");

    sessions.session.lastTurnErrored = true;
    sessions.session.settle("waiting");

    expect((await promise).error).toBe("the agent reported an error");
  });
});

describe("required MCP servers", () => {
  it("abandons the stage when a required server did not connect", async () => {
    const { logger, errors } = capturingLogger();
    const sessions = new FakeSessions();
    const promise = runner(sessions, 1000, logger).run(TASK, "p", "stage:sub-1", {
      requiredMcpServers: ["jira"],
    });

    sessions.session.emit("mcp", {
      servers: [{ name: "jira", status: "failed" }],
      errors: [],
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("jira (failed)");
    // Stopped rather than left running: the point of checking at init is that
    // nothing has been spent on inference yet, and letting it continue spends it.
    expect(sessions.stopped).toEqual(["t1"]);
    expect(errors[0]).toContain("cannot start");
  });

  it("lets the stage run when every required server connected", async () => {
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1", {
      requiredMcpServers: ["jira"],
    });

    sessions.session.emit("mcp", {
      servers: [{ name: "jira", status: "connected" }],
      errors: [],
    });
    sessions.session.reply("done");
    sessions.session.settle("waiting");

    expect((await promise).ok).toBe(true);
    expect(sessions.stopped).toEqual([]);
  });

  /**
   * A stage that asked and never found out must not pass.
   *
   * `ask_user` blocks by design, but the CLI has its own tool timeout. When it fires the
   * agent is told the call failed, proceeds on its own assumptions, and finishes the
   * turn normally — so the session exits tidily, the reply parses, and the stage that
   * asked precisely because it did not know is recorded as having found out.
   */
  it("fails a subtask that ended with a question nobody answered", async () => {
    const sessions = new FakeSessions();
    const captured = capturingLogger();
    const run = new ClaudeStageSessionRunner(
      sessions,
      () => ({ cwd: "/repo" }) as Omit<StreamSessionOptions, "command">,
      captured.logger,
      1000,
      { prepare: () => ({ settingsPath: "/s.json" }), release: () => 2 },
    );
    const promise = run.run(TASK, "p", "stage:sub-1");
    sessions.session.reply("I assumed UAT and carried on.");
    sessions.session.settle("waiting");

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("never answered");
    // The reply is kept: it is the only account of what it assumed.
    expect(result.text).toContain("assumed UAT");
    expect(captured.errors.join("\n")).toContain("askTimeoutMinutes");
  });

  it("leaves a run that answered every question alone", async () => {
    const sessions = new FakeSessions();
    const run = new ClaudeStageSessionRunner(
      sessions,
      () => ({ cwd: "/repo" }) as Omit<StreamSessionOptions, "command">,
      silentLogger,
      1000,
      { prepare: () => ({ settingsPath: "/s.json" }), release: () => 0 },
    );
    const promise = run.run(TASK, "p", "stage:sub-1");
    sessions.session.reply("done");
    sessions.session.settle("waiting");

    expect((await promise).ok).toBe(true);
  });

  // A gate that cannot report the count must not be read as reporting zero — but it
  // also must not fail every stage. Absent means unmeasured, as everywhere else here.
  it("passes a run whose gate does not report unanswered questions", async () => {
    const sessions = new FakeSessions();
    const run = new ClaudeStageSessionRunner(
      sessions,
      () => ({ cwd: "/repo" }) as Omit<StreamSessionOptions, "command">,
      silentLogger,
      1000,
      { prepare: () => ({ settingsPath: "/s.json" }), release: () => undefined },
    );
    const promise = run.run(TASK, "p", "stage:sub-1");
    sessions.session.reply("done");
    sessions.session.settle("waiting");

    expect((await promise).ok).toBe(true);
  });

  // A route that declares nothing must behave exactly as it did before the gate.
  it("ignores MCP startup entirely when the stage required nothing", async () => {
    const sessions = new FakeSessions();
    const promise = runner(sessions).run(TASK, "p", "stage:sub-1");

    sessions.session.emit("mcp", {
      servers: [{ name: "jira", status: "failed" }],
      errors: [{ name: "sftp", message: "bad config" }],
    });
    sessions.session.reply("done");
    sessions.session.settle("waiting");

    expect((await promise).ok).toBe(true);
    expect(sessions.stopped).toEqual([]);
  });
});
