import {
  buildGateSettings,
  denialCallKey,
  describeGateRequest,
  GateDecision,
  GateRequest,
  gateCallKey,
  parseGateRequest,
} from "../agents/permissionGateProtocol";
import { PERMISSION_GATE_SCRIPT } from "../agents/permissionGateScript";
import {
  ApprovalScope,
  gateVerdict,
  StandingApproval,
} from "../domain/permissionGatePolicy";
import {
  interjectionDenialReason,
  isDeliverableInterjection,
  StageInterjection,
} from "../domain/stageInterjection";
import { Logger } from "../logging/logger";

/**
 * Holds a tool call open while a human decides, then lets the agent carry on.
 *
 * The moving parts: a `PreToolUse` hook script (see `permissionGateScript.ts`)
 * parks each gated call as a file in a per-task inbox and polls for an answer.
 * This service watches that inbox, applies `gateVerdict`, and either answers
 * immediately or raises the call to the UI and answers when the user decides.
 *
 * The agent continues **mid-turn** — no re-run, no rule needed to unblock, and no
 * cost beyond the wait. Verified against the CLI: a hook held for 282 seconds and
 * the run then completed with no denials.
 *
 * Filesystem access is injected so the whole thing is testable without touching
 * disk, and without importing `vscode`.
 */

/** The filesystem operations the gate needs, narrowed for testability. */
export interface GateFileSystem {
  mkdirp(directory: string): void;
  writeFile(filePath: string, contents: string): void;
  readFile(filePath: string): string | undefined;
  removeFile(filePath: string): void;
  removeDirectory(directory: string): void;
  listFiles(directory: string): string[];
  join(...segments: string[]): string;
  /**
   * Absolute form of a path.
   *
   * Needed because the hook script and inbox are named inside a settings file
   * that the CLI reads with the *worktree* as its working directory. A relative
   * path there resolves against the wrong place and the gate silently never
   * fires — which looks exactly like the feature being switched off.
   */
  resolve(path: string): string;
}

/** A call currently in front of the user. */
export interface PendingGate {
  taskId: string;
  request: GateRequest;
  callKey: string;
  /** What to show on the row. */
  detail: string;
  /** When it started waiting, so the UI can say how long the agent has been held. */
  waitingSince: string;
}

export interface GateSession {
  /** Pass to the CLI as `--settings`. */
  settingsPath: string;
  /** Where requests and decisions are exchanged. */
  inboxPath: string;
}

const POLL_INTERVAL_MS = 250;
const REQUEST_SUFFIX = ".request.json";

export class PermissionGateService {
  constructor(
    private readonly rootDirectory: string,
    private readonly fs: GateFileSystem,
    private readonly logger: Logger,
    /** Node, or whatever can run the gate script. */
    private readonly interpreter: () => string,
    /** Tools worth gating; others never reach the hook at all. */
    private readonly gatedTools: () => string[],
    /** Ceiling on the wait, in seconds. The CLI enforces it, not the script. */
    private readonly timeoutSeconds: () => number,
    /** Hold every gated call, not only capabilities already refused. */
    private readonly holdEverything: () => boolean = () => false,
    /** Rules the settings file should allow outright; see buildGateSettings. */
    private readonly allowRules: () => string[] = () => [],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private readonly refused = new Map<string, Set<string>>();
  private readonly approvals = new Map<string, Map<string, StandingApproval>>();
  private readonly pending = new Map<string, PendingGate>();
  /** Requests already answered, so a lingering request file is not re-raised. */
  private readonly settled = new Set<string>();
  /**
   * Resolved inbox per task, recorded at `prepare` rather than recomputed.
   *
   * Recomputing it invited the two call sites to disagree — and a decision
   * written to a path the hook is not watching leaves the agent blocked until the
   * CLI's timeout, which is the worst failure this class has.
   */
  private readonly inboxes = new Map<string, string>();
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly listeners = new Set<() => void>();

  /**
   * A message the operator wants the running stage to read, per task.
   *
   * At most one is held. A second replaces the first rather than queueing: each
   * delivery costs a refused tool call, and an operator who types twice before the
   * stage next reaches the gate has corrected themselves, not asked for two
   * interruptions. The UI shows what is waiting, so the replacement is visible.
   *
   * Not persisted. An interjection is addressed to a session that is running now;
   * one that survived a window reload would be delivered to whatever stage happened
   * to be running next, which could be a different stage of a different task's
   * route reading an instruction written about work it has never seen.
   */
  private readonly interjections = new Map<string, StageInterjection>();

  /** Notified once a message has actually reached a stage, for the record. */
  onInterjectionDelivered?: (interjection: StageInterjection) => void;

  /**
   * Queues a message for the running stage, replacing anything undelivered.
   *
   * Returns false when there is no armed gate for the task: without the hook
   * nothing will ever hold a call, so the message would wait forever while the UI
   * showed it as pending. A stage running without the gate cannot be spoken to,
   * and the caller has to say so rather than silently accept the message.
   */
  interject(taskId: string, text: string): boolean {
    if (!isDeliverableInterjection(text) || !this.isArmed(taskId)) return false;
    this.interjections.set(taskId, { taskId, text: text.trim(), at: this.now() });
    this.announce();
    return true;
  }

  /** What is waiting to be said to this task's stage, if anything. */
  pendingInterjection(taskId: string): StageInterjection | undefined {
    return this.interjections.get(taskId);
  }

  /**
   * Drops an undelivered message.
   *
   * Called when a stage ends, because the session it was addressed to is gone —
   * delivering it to the next stage would hand one stage's correction to another,
   * which is the mistake `guidanceFor` exists to prevent one level up.
   */
  clearInterjection(taskId: string): void {
    if (this.interjections.delete(taskId)) this.announce();
  }

  /** Fires whenever the set of waiting calls changes. */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * True when the hook is installed for this task, so a refusal will be held for
   * the user rather than simply refused.
   *
   * Callers that suppress their own reporting because "the gate will handle it"
   * must ask this rather than the setting: `prepare` deliberately fails soft, and
   * a refusal that is neither held nor reported is invisible.
   */
  isArmed(taskId: string): boolean {
    return this.inboxes.has(taskId);
  }

  /** Everything currently waiting, oldest first, optionally for one task. */
  waiting(taskId?: string): PendingGate[] {
    const all = [...this.pending.values()].sort((a, b) =>
      a.waitingSince.localeCompare(b.waitingSince),
    );
    return taskId ? all.filter((p) => p.taskId === taskId) : all;
  }

  /**
   * Materialises the hook for a task and starts watching its inbox.
   *
   * Rewritten every time rather than reused: the script and the settings must
   * match this build of the extension, and a stale hook pointing at an inbox
   * nobody watches would hold a stage until the CLI's timeout.
   */
  prepare(taskId: string): GateSession | undefined {
    try {
      const directory = this.fs.resolve(
        this.fs.join(this.rootDirectory, safeSegment(taskId)),
      );
      const inboxPath = this.fs.join(directory, "inbox");
      const scriptPath = this.fs.join(directory, "gate.js");
      const settingsPath = this.fs.join(directory, "settings.json");

      // Emptied, not just created. `release` clears the inbox when a run ends, but
      // an extension host killed mid-stage — a reload, an update, a crash — never
      // gets there, so the dead CLI's held calls are still on disk. Left behind,
      // the next run's sweep raises them as calls to approve: the hook that would
      // read the decision died with its host, so nothing is waiting, and the
      // prompt is attached to whichever subtask happens to be running now.
      // Discarding them is safe for exactly that reason.
      this.fs.removeDirectory(inboxPath);
      this.fs.mkdirp(inboxPath);
      this.fs.writeFile(scriptPath, PERMISSION_GATE_SCRIPT);
      this.fs.writeFile(
        settingsPath,
        `${JSON.stringify(
          buildGateSettings({
            scriptPath,
            interpreter: this.interpreter(),
            inboxPath,
            timeoutSeconds: this.timeoutSeconds(),
            tools: this.gatedTools(),
            allow: this.allowRules(),
          }),
          null,
          2,
        )}\n`,
      );

      this.inboxes.set(taskId, inboxPath);
      this.watch(taskId, inboxPath);
      return { settingsPath, inboxPath };
    } catch (error) {
      // A gate that cannot be set up must not stop a stage; without it the run
      // behaves exactly as it did before this feature existed.
      this.logger.error(
        `Permission gate could not be prepared for ${taskId}: ${String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Stops watching and removes the inbox.
   *
   * Removing the directory is also the signal to any still-running hook that
   * nobody is listening, so it stops waiting and passes.
   */
  release(taskId: string): void {
    const timer = this.watchers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.watchers.delete(taskId);
    }
    for (const [id, entry] of [...this.pending]) {
      if (entry.taskId === taskId) this.pending.delete(id);
    }
    // An undelivered message dies with the session it was addressed to. Carrying it
    // forward would hand one stage's correction to the next stage to run, which is
    // the failure `guidanceFor` exists to prevent one level up.
    this.interjections.delete(taskId);
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
    this.announce();
  }

  /**
   * Records that the CLI refused a capability, so its retry is held for the user
   * instead of being refused again.
   *
   * This is what makes a pass-by-default gate useful: the first attempt teaches
   * us that a human is needed, and the attempt was one the agent made anyway.
   */
  noteDenial(taskId: string, tool: string, command: string | undefined): void {
    const key = denialCallKey(tool, command);
    const set = this.refused.get(taskId) ?? new Set<string>();
    set.add(key);
    this.refused.set(taskId, set);
  }

  /** Answers a waiting call, and optionally remembers the answer. */
  decide(
    requestId: string,
    decision: Exclude<GateDecision, "pass">,
    scope: ApprovalScope = "once",
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    // "Once" is satisfied by answering this call; storing it would approve the
    // next one too.
    if (scope !== "once") {
      const forTask = this.approvals.get(entry.taskId) ?? new Map();
      forTask.set(entry.callKey, { scope, deny: decision === "deny" });
      this.approvals.set(entry.taskId, forTask);
    }

    this.answer(entry.taskId, requestId, decision, reasonFor(decision, scope));
    this.pending.delete(requestId);
    this.announce();
    this.logger.info(
      `Permission gate: ${decision} ${entry.detail} (${scope}).`,
    );
    return true;
  }

  /** Answers every call waiting on a task with one decision. */
  decideAll(
    taskId: string,
    decision: Exclude<GateDecision, "pass">,
    scope: ApprovalScope = "session",
  ): number {
    const waiting = this.waiting(taskId);
    for (const entry of waiting) this.decide(entry.request.id, decision, scope);
    return waiting.length;
  }

  /** Forgets a task's standing approvals, e.g. when it is archived or removed. */
  forget(taskId: string): void {
    this.approvals.delete(taskId);
    this.refused.delete(taskId);
    this.release(taskId);
  }

  // --- internals --------------------------------------------------------

  /**
   * Polls rather than using a filesystem watcher.
   *
   * `fs.watch` on Windows misses events under load and reports directories
   * inconsistently across network and local paths; a quarter-second poll over a
   * directory that holds at most a handful of files is cheap and never misses.
   */
  private watch(taskId: string, inboxPath: string): void {
    const existing = this.watchers.get(taskId);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => {
      try {
        this.sweep(taskId, inboxPath);
      } catch (error) {
        this.logger.error(`Permission gate sweep failed: ${String(error)}`);
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
      const request = parseGateRequest(id, contents);
      if (!request) {
        // Unreadable: pass rather than leave a stage hanging on a shape we do
        // not understand.
        this.answer(taskId, id, "allow", "Task Workspaces could not read this request.");
        continue;
      }

      // Before any policy question: is the operator trying to say something to
      // this stage? An interjection takes the first call it can get, because the
      // gate is the only channel into a running session — see
      // `domain/stageInterjection.ts` for the two probes that establish that, and
      // for why it must be a denial rather than a waved-through call with a note.
      //
      // Ahead of `gateVerdict` deliberately. A call the policy would pass is the
      // *best* one to spend, since it was going to run unremarked; waiting for one
      // the policy holds would mean the message arrives only when the stage happens
      // to do something contentious, which may be never.
      const interjection = this.interjections.get(taskId);
      if (interjection) {
        this.interjections.delete(taskId);
        this.logger.info(
          `Permission gate: delivering an operator interjection to ${taskId} by holding ${request.toolName}.`,
        );
        this.answer(taskId, id, "deny", interjectionDenialReason(interjection.text));
        this.onInterjectionDelivered?.(interjection);
        continue;
      }

      const callKey = gateCallKey(request);
      const verdict = gateVerdict(
        {
          refused: this.refused.get(taskId) ?? new Set(),
          approvals: this.approvals.get(taskId) ?? new Map(),
          holdEverything: this.holdEverything(),
        },
        callKey,
      );

      if (verdict.kind === "pass") {
        this.answerPass(taskId, id);
        continue;
      }
      if (verdict.kind === "answer") {
        this.answer(taskId, id, verdict.decision, verdict.reason);
        continue;
      }

      const detail = describeGateRequest(request);
      this.pending.set(id, {
        taskId,
        request,
        callKey,
        detail,
        waitingSince: this.now(),
      });
      this.logger.info(
        `Permission gate: holding ${request.toolName} — ${detail}. Waiting for a decision.`,
      );
      this.announce();
    }
  }

  private answerPass(taskId: string, requestId: string): void {
    this.write(taskId, requestId, { decision: "pass" });
  }

  private answer(
    taskId: string,
    requestId: string,
    decision: Exclude<GateDecision, "pass">,
    reason: string,
  ): void {
    this.write(taskId, requestId, { decision, reason });
  }

  private write(
    taskId: string,
    requestId: string,
    body: { decision: GateDecision; reason?: string },
  ): void {
    // Recorded before the write: a settled request must never be raised again,
    // even if removing its file fails. Asking the user twice about one call is
    // the worst outcome this class can produce.
    this.settled.add(requestId);
    try {
      const inboxPath = this.inboxes.get(taskId);
      if (!inboxPath) {
        this.logger.error(
          `Permission gate has no inbox for ${taskId}; cannot answer ${requestId}.`,
        );
        return;
      }
      // The script tolerates a partial read by retrying, so a plain write is safe.
      this.fs.writeFile(
        this.fs.join(inboxPath, `${requestId}.decision.json`),
        JSON.stringify(body),
      );
      // The script removes both files once it has read the answer, but it may
      // have been killed with the stage. Dropping the request here keeps sweeps
      // idempotent either way.
      this.fs.removeFile(this.fs.join(inboxPath, `${requestId}${REQUEST_SUFFIX}`));
    } catch (error) {
      this.logger.error(
        `Permission gate could not answer ${requestId}: ${String(error)}`,
      );
    }
  }

  dispose(): void {
    for (const timer of this.watchers.values()) clearInterval(timer);
    this.watchers.clear();
    this.pending.clear();
    this.listeners.clear();
  }
}

function reasonFor(decision: GateDecision, scope: ApprovalScope): string {
  if (decision === "deny") return "Denied in Task Workspaces.";
  switch (scope) {
    case "once":
      return "Approved once in Task Workspaces.";
    case "session":
      return "Approved for this session in Task Workspaces.";
    case "always":
      return "Approved in Task Workspaces; a rule was added.";
  }
}

/**
 * Task ids are ours, but they end up in a path.
 *
 * Dots are dropped rather than kept: an id is only ever a generated identifier,
 * so nothing needs them, and allowing them leaves `..` intact in the segment.
 */
function safeSegment(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "_");
}
