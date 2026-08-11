import { beforeEach, describe, expect, it } from "vitest";
import { AskUserService, PendingAsk } from "./askUserService";
import { GateFileSystem } from "./permissionGateService";
import { Logger } from "../logging/logger";
import { ASK_SERVER_NAME } from "../agents/askUserProtocol";

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function memoryFs(): GateFileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    join: (...segments) => segments.join("/"),
    resolve: (target) => (target.startsWith("/") ? target : `/abs/${target}`),
    mkdirp: () => {},
    writeFile: (filePath, contents) => {
      files.set(filePath, contents);
    },
    readFile: (filePath) => files.get(filePath),
    removeFile: (filePath) => {
      files.delete(filePath);
    },
    removeDirectory: (directory) => {
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${directory}/`)) files.delete(key);
      }
    },
    listFiles: (directory) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${directory}/`))
        .map((key) => key.slice(directory.length + 1))
        .filter((name) => !name.includes("/")),
  };
}

const INBOX = "/abs/asks/t1/questions";

function ask(questions: string[], context?: string): string {
  return JSON.stringify({ questions, context });
}

describe("prepare", () => {
  it("writes the server and an mcp config naming it", () => {
    const fs = memoryFs();
    const service = new AskUserService("asks", fs, logger, () => "node");
    const session = service.prepare("t1")!;

    expect(session.mcpConfigPath).toBe("/abs/asks/t1/ask-mcp.json");
    expect(fs.readFile("/abs/asks/t1/ask-user-server.js")).toContain("ask_user");

    const config = JSON.parse(fs.readFile(session.mcpConfigPath)!);
    const server = config.mcpServers[ASK_SERVER_NAME];
    expect(server.command).toBe("node");
    expect(server.args).toEqual([
      "/abs/asks/t1/ask-user-server.js",
      "/abs/asks/t1/questions",
    ]);
    service.dispose();
  });

  it("names absolute paths, since the CLI launches the server from the worktree", () => {
    const fs = memoryFs();
    const service = new AskUserService("asks", fs, logger, () => "node");
    const session = service.prepare("t1")!;
    expect(session.mcpConfigPath.startsWith("/")).toBe(true);
    expect(session.inboxPath.startsWith("/")).toBe(true);
    service.dispose();
  });

  it("discards questions left waiting by a host that died mid-stage", () => {
    // Nothing is on the other end of these: the server that would read an answer
    // died with its host. Raised again, they would block a stage on a question
    // asked by a subtask that is no longer running.
    const fs = memoryFs();
    const service = new AskUserService("asks", fs, logger, () => "node");
    const first = service.prepare("t1")!;
    fs.writeFile(`${first.inboxPath}/stale.ask.json`, ask(["Which environment?"]));

    const second = service.prepare("t1")!;
    service.sweep("t1", second.inboxPath);

    expect(fs.readFile(`${second.inboxPath}/stale.ask.json`)).toBeUndefined();
    expect(service.waiting()).toHaveLength(0);
    service.dispose();
  });

  it("writes a server that never logs to stdout", () => {
    // Anything on stdout is framed as a JSON-RPC message, and one stray line makes
    // the CLI drop the server — so the tool would silently vanish.
    const fs = memoryFs();
    const service = new AskUserService("asks", fs, logger, () => "node");
    const session = service.prepare("t1")!;
    const script = fs.readFile("/abs/asks/t1/ask-user-server.js")!;
    void session;
    expect(script).not.toContain("console.log");
    expect(script).toContain("process.stderr.write");
    service.dispose();
  });
});

describe("sweeping questions", () => {
  let fs: ReturnType<typeof memoryFs>;
  let service: AskUserService;
  let raised: PendingAsk[];

  beforeEach(() => {
    fs = memoryFs();
    service = new AskUserService("asks", fs, logger, () => "node", () => "2026-08-04T10:00:00.000Z");
    service.prepare("t1");
    raised = [];
    service.onAsked((a) => raised.push(a));
  });

  it("raises a question so it can be recorded and shown", () => {
    fs.writeFile(`${INBOX}/c1.ask.json`, ask(["Which environment?"], "deploy"));
    service.sweep("t1", INBOX);

    expect(raised).toHaveLength(1);
    expect(raised[0].request.questions).toEqual(["Which environment?"]);
    expect(raised[0].request.context).toBe("deploy");
    expect(service.waiting("t1")).toHaveLength(1);
  });

  it("does not answer a raised question by itself", () => {
    // The agent must stay blocked: that is the whole point.
    fs.writeFile(`${INBOX}/c1.ask.json`, ask(["Q?"]));
    service.sweep("t1", INBOX);
    expect(fs.readFile(`${INBOX}/c1.answers.json`)).toBeUndefined();
  });

  it("does not raise the same question twice across sweeps", () => {
    fs.writeFile(`${INBOX}/c1.ask.json`, ask(["Q?"]));
    service.sweep("t1", INBOX);
    service.sweep("t1", INBOX);
    expect(raised).toHaveLength(1);
  });

  it("tells the agent to proceed when a question cannot be read", () => {
    fs.writeFile(`${INBOX}/c1.ask.json`, "not json");
    service.sweep("t1", INBOX);
    expect(raised).toHaveLength(0);
    expect(JSON.parse(fs.readFile(`${INBOX}/c1.answers.json`)!).abandoned).toBe(true);
  });

  it("ignores partial files still being written", () => {
    fs.writeFile(`${INBOX}/c1.ask.json.partial`, ask(["Q?"]));
    service.sweep("t1", INBOX);
    expect(raised).toHaveLength(0);
  });
});

describe("answering", () => {
  let fs: ReturnType<typeof memoryFs>;
  let service: AskUserService;

  beforeEach(() => {
    fs = memoryFs();
    service = new AskUserService("asks", fs, logger, () => "node");
    service.prepare("t1");
  });

  function raise(id: string, questions: string[]) {
    fs.writeFile(`${INBOX}/${id}.ask.json`, ask(questions));
    service.sweep("t1", INBOX);
  }

  it("writes answers where the waiting server will read them", () => {
    raise("c1", ["Which environment?", "Which variant?"]);
    expect(service.answer("c1", ["UAT", "NWE"])).toBe(true);

    const written = JSON.parse(fs.readFile(`${INBOX}/c1.answers.json`)!);
    expect(written.answers).toEqual(["UAT", "NWE"]);
    expect(written.abandoned).toBeUndefined();
    expect(service.waiting("t1")).toHaveLength(0);
  });

  it("removes the question so a later sweep cannot re-raise it", () => {
    raise("c1", ["Q?"]);
    service.answer("c1", ["A"]);
    expect(fs.readFile(`${INBOX}/c1.ask.json`)).toBeUndefined();
  });

  it("reports false for a question no longer waiting", () => {
    // The stage timed out or was stopped; the caller must say so rather than
    // appear to have answered.
    expect(service.answer("gone", ["A"])).toBe(false);
  });

  it("abandons on request so a stopped task does not leave the agent blocked", () => {
    raise("c1", ["Q?"]);
    expect(service.abandon("t1")).toBe(1);
    expect(JSON.parse(fs.readFile(`${INBOX}/c1.answers.json`)!).abandoned).toBe(true);
    expect(service.waiting("t1")).toHaveLength(0);
  });

  it("abandons everything outstanding when released", () => {
    raise("c1", ["Q?"]);
    raise("c2", ["Q2?"]);
    service.release("t1");
    expect(service.waiting("t1")).toHaveLength(0);
  });

  it("keeps questions separate between tasks", () => {
    service.prepare("t2");
    raise("c1", ["Q?"]);
    fs.writeFile("/abs/asks/t2/questions/c9.ask.json", ask(["Other?"]));
    service.sweep("t2", "/abs/asks/t2/questions");

    expect(service.waiting("t1")).toHaveLength(1);
    expect(service.waiting("t2")).toHaveLength(1);
    expect(service.abandon("t1")).toBe(1);
    expect(service.waiting("t2")).toHaveLength(1);
  });
});

/**
 * The measurement `ask_user` was quietly breaking.
 *
 * The answer returns into the waiting turn, which is why the tool is cheaper than
 * `NEEDS-INFO` — and the side effect is that the operator's thinking time sits inside
 * the running subtask's span. A real 23-stage route reported 4% idle while its
 * 32-minute implementation stage had asked two questions, so supervision was being
 * counted as execution.
 */
describe("time spent waiting on a human", () => {
  let fs: ReturnType<typeof memoryFs>;
  let service: AskUserService;
  let clock: string;

  beforeEach(() => {
    fs = memoryFs();
    clock = "2026-08-11T09:00:00.000Z";
    service = new AskUserService("asks", fs, logger, () => "node", () => clock);
    service.prepare("t1");
  });

  function raise(id: string, questions: string[]) {
    fs.writeFile(`${INBOX}/${id}.ask.json`, ask(questions));
    service.sweep("t1", INBOX);
  }

  function at(time: string) {
    clock = time;
  }

  it("starts at nothing", () => {
    expect(service.humanWaitMs("t1")).toBe(0);
  });

  it("counts how long an answered question was waiting", () => {
    raise("c1", ["Which environment?"]);
    at("2026-08-11T09:03:20.000Z");
    service.answer("c1", ["UAT"]);
    expect(service.humanWaitMs("t1")).toBe(200_000);
  });

  // A stage that asked twice waited twice, and a real one did.
  it("accumulates across several questions", () => {
    raise("c1", ["First?"]);
    at("2026-08-11T09:01:00.000Z");
    service.answer("c1", ["a"]);

    raise("c2", ["Second?"]);
    at("2026-08-11T09:04:00.000Z");
    service.answer("c2", ["b"]);

    expect(service.humanWaitMs("t1")).toBe(4 * 60_000);
  });

  // Abandoned time is still time the stage was blocked and not working. Counting only
  // answers would make a stopped task look as though its stages ran fast.
  it("counts a wait that was abandoned rather than answered", () => {
    raise("c1", ["Q?"]);
    at("2026-08-11T09:02:00.000Z");
    service.abandon("t1");
    expect(service.humanWaitMs("t1")).toBe(2 * 60_000);
  });

  /**
   * The ordering that makes this work at all.
   *
   * `release` is called from inside `StageSessionRunner.run` as the session ends,
   * which is *before* the runner takes its closing reading. Clearing the total there
   * would make the runner's difference negative and discard the wait `release` had
   * just recorded through `abandon`.
   */
  it("keeps the total after release, so the runner's closing reading still sees it", () => {
    raise("c1", ["Q?"]);
    at("2026-08-11T09:05:00.000Z");
    service.release("t1");
    expect(service.humanWaitMs("t1")).toBe(5 * 60_000);
  });

  it("attributes waits to the task that waited", () => {
    service.prepare("t2");
    raise("c1", ["Q?"]);
    fs.writeFile("/abs/asks/t2/questions/c9.ask.json", ask(["Other?"]));
    service.sweep("t2", "/abs/asks/t2/questions");

    at("2026-08-11T09:01:00.000Z");
    service.answer("c1", ["a"]);
    expect(service.humanWaitMs("t1")).toBe(60_000);
    expect(service.humanWaitMs("t2")).toBe(0);
  });

  it("does not count a question that is still outstanding", () => {
    raise("c1", ["Q?"]);
    at("2026-08-11T09:07:00.000Z");
    expect(service.humanWaitMs("t1")).toBe(0);
    // Reported separately, because a stage blocked right now is where the wait matters
    // most and it has not ended yet.
    expect(service.waitingForMs("c1")).toBe(7 * 60_000);
  });

  it("reports no current wait for an id nothing is waiting under", () => {
    expect(service.waitingForMs("nope")).toBe(0);
  });

  it("ignores an answer for a question that is no longer waiting", () => {
    raise("c1", ["Q?"]);
    at("2026-08-11T09:01:00.000Z");
    service.answer("c1", ["a"]);
    at("2026-08-11T09:09:00.000Z");
    expect(service.answer("c1", ["again"])).toBe(false);
    expect(service.humanWaitMs("t1")).toBe(60_000);
  });
});
