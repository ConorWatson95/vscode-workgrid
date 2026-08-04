import {
  AskRequest,
  buildAskMcpConfig,
  parseAskRequest,
} from "../agents/askUserProtocol";
import { ASK_USER_SERVER_SCRIPT } from "../agents/askUserServerScript";
import { GateFileSystem } from "./permissionGateService";
import { Logger } from "../logging/logger";

/**
 * Lets a stage ask the user a question without ending its session.
 *
 * Without this, a stage that lacks information stops, the questions are stored,
 * and answering them re-runs the whole subtask from the beginning — so the
 * information costs a stage rather than a pause. Here the agent calls a blocking
 * MCP tool, this service raises the question, and the answer comes back as the
 * tool's result, mid-turn, with everything the agent had worked out intact.
 *
 * Structurally the twin of `PermissionGateService` — request file, poll, answer
 * file — and it borrows that class's `GateFileSystem` so both stay testable
 * without touching disk or importing `vscode`.
 */

/** A question the agent is blocked on right now. */
export interface PendingAsk {
  taskId: string;
  request: AskRequest;
  /** When it started waiting, so the UI can say how long the agent has been held. */
  waitingSince: string;
}

export interface AskSession {
  /** Pass to the CLI as an extra `--mcp-config`. */
  mcpConfigPath: string;
  /** Where questions and answers are exchanged. */
  inboxPath: string;
}

const POLL_INTERVAL_MS = 300;
const REQUEST_SUFFIX = ".ask.json";

export class AskUserService {
  constructor(
    private readonly rootDirectory: string,
    private readonly fs: GateFileSystem,
    private readonly logger: Logger,
    /** Node, or whatever can run the server script. */
    private readonly interpreter: () => string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private readonly pending = new Map<string, PendingAsk>();
  private readonly settled = new Set<string>();
  private readonly inboxes = new Map<string, string>();
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly listeners = new Set<(ask: PendingAsk) => void>();

  /** Fires when a new question arrives, so it can be recorded and shown. */
  onAsked(listener: (ask: PendingAsk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Everything currently waiting, oldest first, optionally for one task. */
  waiting(taskId?: string): PendingAsk[] {
    const all = [...this.pending.values()].sort((a, b) =>
      a.waitingSince.localeCompare(b.waitingSince),
    );
    return taskId ? all.filter((p) => p.taskId === taskId) : all;
  }

  /** The question waiting under a given id, if it still is. */
  get(callId: string): PendingAsk | undefined {
    return this.pending.get(callId);
  }

  /**
   * Materialises the server for a task and starts watching its inbox.
   *
   * Rewritten every time: the script must match this build, and a config naming
   * an inbox nobody watches would let a stage block until the tool timeout.
   */
  prepare(taskId: string): AskSession | undefined {
    try {
      const directory = this.fs.resolve(
        this.fs.join(this.rootDirectory, safeSegment(taskId)),
      );
      const inboxPath = this.fs.join(directory, "questions");
      const serverPath = this.fs.join(directory, "ask-user-server.js");
      const mcpConfigPath = this.fs.join(directory, "ask-mcp.json");

      // Emptied for the same reason as the permission gate's inbox: a host killed
      // mid-stage leaves the dead CLI's `tools/call` on disk, and the next run
      // would raise it as a live question against a different subtask. Answering
      // it would write an answer no process is left to read, so the stage would
      // sit blocked on a question that was never its own.
      this.fs.removeDirectory(inboxPath);
      this.fs.mkdirp(inboxPath);
      this.fs.writeFile(serverPath, ASK_USER_SERVER_SCRIPT);
      this.fs.writeFile(
        mcpConfigPath,
        `${JSON.stringify(
          buildAskMcpConfig({
            interpreter: this.interpreter(),
            serverPath,
            inboxPath,
          }),
          null,
          2,
        )}\n`,
      );

      this.inboxes.set(taskId, inboxPath);
      this.watch(taskId, inboxPath);
      return { mcpConfigPath, inboxPath };
    } catch (error) {
      // Without the tool a stage falls back to ending its session and reporting
      // NEEDS-INFO, which is slower but not broken.
      this.logger.error(
        `Ask-user server could not be prepared for ${taskId}: ${String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Answers a waiting question.
   *
   * Returns false when nothing is waiting under that id, which happens when the
   * stage timed out or was stopped — the caller says so rather than appearing to
   * have done something.
   */
  answer(callId: string, answers: readonly string[]): boolean {
    const ask = this.pending.get(callId);
    if (!ask) return false;
    this.write(ask.taskId, callId, { answers: [...answers] });
    this.pending.delete(callId);
    this.logger.info(
      `Ask-user: answered ${ask.request.questions.length} question(s) for a live stage.`,
    );
    return true;
  }

  /**
   * Tells every question waiting on a task that no answer is coming.
   *
   * Called when a task is stopped: leaving the agent blocked would hold the CLI
   * until the tool timeout, and the server turns this into an instruction to
   * proceed on its own judgement and declare its assumptions.
   */
  abandon(taskId: string): number {
    const waiting = this.waiting(taskId);
    for (const ask of waiting) {
      this.write(taskId, ask.request.id, { answers: [], abandoned: true });
      this.pending.delete(ask.request.id);
    }
    if (waiting.length > 0) {
      this.logger.info(
        `Ask-user: abandoned ${waiting.length} question(s); the agent was told to proceed.`,
      );
    }
    return waiting.length;
  }

  /**
   * Stops watching and removes the inbox.
   *
   * Anything still waiting is abandoned first: removing the directory alone tells
   * the server nobody is listening, but only on its next poll, and being explicit
   * is what makes the agent's next turn immediate.
   */
  release(taskId: string): void {
    this.abandon(taskId);
    const timer = this.watchers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.watchers.delete(taskId);
    }
    const inboxPath = this.inboxes.get(taskId);
    this.inboxes.delete(taskId);
    try {
      this.fs.removeDirectory(
        inboxPath ??
          this.fs.resolve(this.fs.join(this.rootDirectory, safeSegment(taskId))),
      );
    } catch {
      /* best effort */
    }
  }

  // --- internals --------------------------------------------------------

  /** Polls, for the same reasons as the permission gate's inbox sweep. */
  private watch(taskId: string, inboxPath: string): void {
    const existing = this.watchers.get(taskId);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => {
      try {
        this.sweep(taskId, inboxPath);
      } catch (error) {
        this.logger.error(`Ask-user sweep failed: ${String(error)}`);
      }
    }, POLL_INTERVAL_MS);
    this.watchers.set(taskId, timer);
  }

  /** Called by tests to drive the poll deterministically. */
  sweep(taskId: string, inboxPath: string): void {
    for (const name of this.fs.listFiles(inboxPath)) {
      if (!name.endsWith(REQUEST_SUFFIX)) continue;
      const id = name.slice(0, -REQUEST_SUFFIX.length);
      if (this.pending.has(id) || this.settled.has(id)) continue;

      const contents = this.fs.readFile(this.fs.join(inboxPath, name));
      if (contents === undefined) continue;

      const request = parseAskRequest(id, contents);
      if (!request) {
        // Unreadable: tell the agent to proceed rather than leaving it blocked on
        // a shape we do not understand.
        this.logger.warn(`Ask-user: could not read a question; telling the agent to proceed.`);
        this.write(taskId, id, { answers: [], abandoned: true });
        continue;
      }

      const ask: PendingAsk = { taskId, request, waitingSince: this.now() };
      this.pending.set(id, ask);
      this.logger.info(
        `Ask-user: ${request.questions.length} question(s) from a live stage; the agent is waiting.`,
      );
      for (const listener of this.listeners) listener(ask);
    }
  }

  private write(
    taskId: string,
    callId: string,
    body: { answers: string[]; abandoned?: boolean },
  ): void {
    // Recorded before the write: a settled question must never be raised twice.
    this.settled.add(callId);
    const inboxPath = this.inboxes.get(taskId);
    if (!inboxPath) {
      this.logger.error(`Ask-user has no inbox for ${taskId}; cannot answer ${callId}.`);
      return;
    }
    try {
      this.fs.writeFile(
        this.fs.join(inboxPath, `${callId}.answers.json`),
        JSON.stringify(body),
      );
      // The server removes both once it has read the answer, but it may have been
      // killed with the stage. Dropping the request keeps sweeps idempotent.
      this.fs.removeFile(this.fs.join(inboxPath, `${callId}${REQUEST_SUFFIX}`));
    } catch (error) {
      this.logger.error(`Ask-user could not answer ${callId}: ${String(error)}`);
    }
  }

  dispose(): void {
    for (const timer of this.watchers.values()) clearInterval(timer);
    this.watchers.clear();
    this.pending.clear();
    this.listeners.clear();
  }
}

/** Task ids are ours, but they end up in a path. Dots dropped so `..` cannot survive. */
function safeSegment(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "_");
}
