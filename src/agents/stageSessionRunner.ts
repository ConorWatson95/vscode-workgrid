import { TaskWorkspace } from "../domain/taskWorkspace";
import { StreamSessionOptions } from "./claudeStreamSession";
import { ChatItem } from "./streamJson";
import { DenialWatcher, PermissionDenial } from "./permissionDenials";
import { StageActivityWatcher } from "./stageActivity";
import { SessionTokenTotals, SubtaskActivity } from "../domain/taskPipeline";
import { StageSessionRunner } from "../services/pipelineRunner";
import { Logger } from "../logging/logger";
import { redactSecrets } from "../domain/secretRedaction";
import { assessMcpReadiness } from "../domain/mcpReadiness";
import { stageTools as defaultStageTools } from "../domain/stageTools";
import { stageTimeoutDecision } from "../domain/stageTimeout";
import { McpServerError, McpServerStatus } from "../domain/mcpServerStatus";

/** How often a running stage's progress is reported to whoever is watching. */
export const ACTIVITY_INTERVAL_MS = 1500;

/** The part of a live session a stage run observes. */
export interface StageSession {
  readonly items: readonly ChatItem[];
  readonly sessionId?: string;
  readonly lastTurnErrored: boolean;
  /** What the CLI said went wrong, when it did. */
  readonly lastTurnError?: string;
  /**
   * How the process ended: exit code, and whatever stderr it left.
   *
   * The only account available when a session stops having produced no assistant text
   * — the path that used to report the bare string `session stopped`.
   */
  readonly exitDetail?: string;
  /**
   * Cumulative cost and tokens for the session, once it has reported a result.
   *
   * Read from the session rather than accumulated from `items`: the CLI reports
   * both on its `result` event, which never becomes a transcript item, so no
   * amount of watching the item stream would find them.
   */
  readonly costUsd?: number;
  readonly tokenTotals?: SessionTokenTotals;
  /**
   * The model the CLI resolved, from its init event — which is not always the one
   * asked for, since a disallowed model falls back silently.
   */
  readonly activeModel?: string;
  on(event: "status", listener: (status: string) => void): unknown;
  on(event: "item", listener: (item: ChatItem) => void): unknown;
  on(event: "mcp", listener: (report: McpStartupReport) => void): unknown;
  off(event: "status", listener: (status: string) => void): unknown;
  off(event: "item", listener: (item: ChatItem) => void): unknown;
  off(event: "mcp", listener: (report: McpStartupReport) => void): unknown;
}

/** What the CLI said about MCP startup, once, before the first turn. */
export interface McpStartupReport {
  servers: McpServerStatus[];
  errors: McpServerError[];
}

/**
 * The part of `AgentSessionManager` a stage run needs. Narrowed to an interface
 * so the run loop can be tested without spawning a CLI.
 */
export interface StageSessions {
  create(
    taskId: string,
    options: Omit<StreamSessionOptions, "command">,
    initialPrompt?: string,
  ): StageSession;
  stop(taskId: string): void;
}

/**
 * The permission gate, as far as a stage run needs it: somewhere to install the
 * hook before the session starts, and somewhere to hand it back afterwards.
 *
 * Narrowed to an interface so the run loop keeps its existing tests, which have
 * no filesystem.
 */
export interface StageGate {
  /**
   * Installs whatever the stage needs to talk back to the user, and returns the
   * CLI arguments that reach it: a settings file for the permission hook, and
   * extra MCP configs for the ask_user server.
   *
   * Either may be absent — each feature is separately switchable and each fails
   * soft — so a stage still runs when neither is installed.
   */
  prepare(taskId: string):
    | { settingsPath?: string; extraMcpConfigPaths?: string[] }
    | undefined;
  /**
   * Stops watching. Also tells any still-blocked hook that nobody is listening.
   *
   * Returns how many questions were **still unanswered** when the session ended, which
   * is not a tidy-up statistic: it is the only evidence the harness has that a stage
   * asked something and never found out. The CLI's tool timeout fires on its side, the
   * agent proceeds on assumptions, and the session then ends normally — so by the time
   * anything here looks, the run is indistinguishable from one that never asked.
   *
   * Undefined is "the gate does not report this", not zero — a gate that cannot tell us
   * must not be read as telling us nothing was lost.
   */
  release(taskId: string): number | void;
}

/**
 * Runs one stage prompt to completion in a **fresh** Claude session.
 *
 * `AgentSessionManager.create` stops any existing session for the task first, so
 * every subtask genuinely starts with an empty context. That is the point of
 * driving a route through subtasks at all: without the fresh start this would be
 * one long conversation with a checklist bolted on.
 */
export class ClaudeStageSessionRunner implements StageSessionRunner {
  constructor(
    private readonly sessions: StageSessions,
    private readonly optionsFor: (
      task: TaskWorkspace,
    ) => Omit<StreamSessionOptions, "command">,
    private readonly logger: Logger,
    /** Hard stop per subtask, so a hung CLI cannot stall the route forever. */
    private readonly timeoutMs = 15 * 60 * 1000,
    /**
     * Holds refused tool calls open for the user instead of letting them be
     * denied. Optional: without it a stage behaves as it did before the gate
     * existed, which is also the fallback when the hook cannot be installed.
     */
    private readonly gate?: StageGate,
    /**
     * The built-in tool set a stage declares, read per run so a project can widen
     * it without a restart — the same reason `discardPaths` and `gatedTools` are
     * functions. Defaults to the measured set; returning an empty list restores the
     * CLI's own default, which is the escape hatch if a route needs a tool nobody
     * has needed yet.
     */
    private readonly stageTools: () => string[] = () => defaultStageTools(),
    /**
     * Blocked-on-human time for a task so far, including a wait still open.
     *
     * Subtracted from the elapsed time before the hard stop fires, because
     * `timeoutMs` bounds a *hung CLI* and a stage waiting on a person is not hung —
     * see `domain/stageTimeout.ts`. Optional, and absent means unmeasured rather
     * than zero: without it the timer behaves exactly as it did before.
     */
    private readonly blockedOnHumanMs?: (taskId: string) => number,
  ) {}

  run(
    task: TaskWorkspace,
    prompt: string,
    label: string,
    options?: {
      model?: string;
      /** Called the instant a tool call is refused, while the stage still runs. */
      onDenial?: (denial: PermissionDenial) => void;
      /** Called as the run works, throttled to `ACTIVITY_INTERVAL_MS`. */
      onActivity?: (activity: SubtaskActivity) => void;
      /**
       * MCP servers this stage cannot do its job without. Checked against the
       * CLI's init event and the stage is abandoned if any is unavailable —
       * before the model acts, which is the only point at which abandoning it
       * costs nothing.
       */
      requiredMcpServers?: readonly string[];
    },
  ): Promise<{
    ok: boolean;
    text: string;
    sessionId?: string;
    error?: string;
    denials?: PermissionDenial[];
    activity?: SubtaskActivity;
  }> {
    const override = options?.model?.trim();
    this.logger.info(
      `Harness [${task.name}] running ${label} in a fresh session` +
        (override ? ` on ${override}.` : "."),
    );

    // Auto-compaction is disabled for stage sessions, and cannot help them: it
    // is applied when a turn settles, and a subtask is a single turn, so the
    // only compaction it could ever run is one on a session this runner has
    // already finished with. Left enabled it spent a model turn summarising a
    // context nobody would read again, once per subtask.
    const base = this.optionsFor(task);
    // Installed per subtask, because each one is a fresh CLI process and the
    // hook is passed as a command-line argument.
    const gateSession = this.gate?.prepare(task.id);
    const session = this.sessions.create(
      task.id,
      {
        ...base,
        settingsPath: gateSession?.settingsPath ?? base.settingsPath,
        extraMcpConfigPaths: [
          ...(base.extraMcpConfigPaths ?? []),
          ...(gateSession?.extraMcpConfigPaths ?? []),
        ],
        autoCompactThreshold: 0,
        // Declared for stage sessions only, and this is the boundary that matters:
        // a hand-driven chat is not a stage, and narrowing a person's tools to the
        // set stages happen to use would be the runtime deciding what a human may
        // do. Measured at 47% of the prefix — see `domain/stageTools.ts`.
        tools: this.stageTools(),
        // A stage's own model wins; an absent or blank one leaves the
        // extension-wide setting in place rather than clearing it.
        model: override && override.length > 0 ? override : base.model,
      },
      prompt,
    );

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: {
        ok: boolean;
        text: string;
        sessionId?: string;
        error?: string;
        denials?: PermissionDenial[];
        activity?: SubtaskActivity;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off("status", onStatus);
        session.off("item", onItem);
        session.off("mcp", onMcp);
        // Every failing path logs here, so none can be added later that reports
        // nothing. The counts matter as much as the reason: "died having run no
        // tools" and "died after forty" are different problems, and the failure
        // reason alone reads the same either way.
        if (!result.ok) {
          this.logger.error(
            `Harness [${task.name}] ${label} failed: ${result.error ?? "unknown"}` +
              ` (session ${result.sessionId ?? "unknown"}, ` +
              `${describeProgress(result.activity)}).` +
              " Open Show What This Did on the stage for the full account.",
          );
        }
        // The CLI has gone, so anything still holding is holding for nothing —
        // and a row the user could click but never satisfy is worse than none.
        const unanswered = gateSession ? (this.gate?.release(task.id) ?? 0) : 0;
        // A question outstanding at session end was never answered by anyone: the CLI's
        // tool timeout fired, and the agent carried on having answered itself. Nothing
        // downstream can see that — the reply parses, the session exited tidily, and
        // `finishSubtask(..., "done")` records a process that ended. The same disease as
        // every marker in this protocol: a fallback that reads as success.
        //
        // Failed rather than held, and only when the run was otherwise fine: a run that
        // already failed has a truer reason, and overwriting it would hide it.
        if (unanswered > 0 && result.ok) {
          this.logger.error(
            `Harness [${task.name}] ${label} ended with ${unanswered} question(s) never ` +
              "answered — the CLI's tool timeout fired and the stage proceeded on its own " +
              "assumptions. Set taskWorkspaces.askTimeoutMinutes to 0 to wait " +
              "indefinitely, then re-run it.",
          );
          resolve({
            ...result,
            ok: false,
            error:
              `asked ${unanswered} question(s) that were never answered, and continued ` +
              "on its own assumptions",
          });
          return;
        }
        resolve(result);
      };

      // The budget is *working* time, so the timer re-arms rather than fires once: a
      // stage held on `ask_user` for an hour has used none of it, and the wait is only
      // known when the timer looks. Sampled either side of the session like
      // `blockedOnHumanMs`, since the tally is per task and survives a subtask.
      const startedAt = Date.now();
      const blockedBefore = this.blockedOnHumanMs?.(task.id);
      let timer: ReturnType<typeof setTimeout>;
      const onDeadline = () => {
        const blocked =
          blockedBefore === undefined
            ? undefined
            : (this.blockedOnHumanMs?.(task.id) ?? blockedBefore) - blockedBefore;
        const decision = stageTimeoutDecision(
          Date.now() - startedAt,
          this.timeoutMs,
          blocked,
        );
        if (decision.kind === "rearm") {
          // Announced, because a stage sitting past its own limit is otherwise
          // indistinguishable from the cap not working — the rule a truncated report
          // and a discarded file both follow.
          this.logger.info(
            `Harness [${task.name}] ${label} is past the ${Math.round(
              this.timeoutMs / 60000,
            )}-minute limit but has spent ${Math.round(
              (blocked ?? 0) / 60000,
            )} minute(s) waiting on an answer, so the limit has not been reached.`,
          );
          timer = setTimeout(onDeadline, decision.afterMs);
          return;
        }
        const minutes = Math.round(this.timeoutMs / 60000);
        this.logger.warn(
          `Harness [${task.name}] ${label} hit the ${minutes}-minute limit; stopping it. ` +
            `Raise taskWorkspaces.stageTimeoutMinutes if stages here legitimately take longer.`,
        );
        this.sessions.stop(task.id);
        // Keep whatever it produced. The stage still fails — an interrupted
        // stage has not done its job — but discarding the reply threw away tens
        // of minutes of investigation and left nothing to diagnose from.
        finish({
          ok: false,
          text: lastAssistantText(),
          sessionId: session.sessionId,
          error: `timed out after ${minutes} minute(s) of working time`,
          denials: denials(),
          activity: activity(),
        });
      };
      timer = setTimeout(onDeadline, this.timeoutMs);

      // Watched live rather than scanned at the end: the refusal happens seconds
      // in, and the agent then spends turns working around it.
      const watcher = new DenialWatcher();
      // Fed from the same subscription, so recording what the stage did costs
      // nothing beyond the memory it holds.
      const activityWatcher = new StageActivityWatcher();
      // Throttled: a stage produces items several a second, and each report costs
      // a full render of everything it has done. A couple of seconds behind is
      // indistinguishable from live to a reader, and free.
      let lastReport = 0;
      const onItem = (item: ChatItem) => {
        activityWatcher.observe(item);
        if (options?.onActivity && !activityWatcher.isEmpty()) {
          const now = Date.now();
          if (now - lastReport >= ACTIVITY_INTERVAL_MS) {
            lastReport = now;
            options.onActivity(activityWatcher.result());
          }
        }
        const denial = watcher.observe(item);
        if (!denial) return;
        this.logger.warn(
          `Harness [${task.name}] ${label}: ${denial.tool} denied — ${denial.reason}`,
        );
        options?.onDenial?.(denial);
      };
      const denials = (): PermissionDenial[] => watcher.all();
      // Cost and tokens are taken from the session rather than the watcher: the
      // CLI reports them on its `result` event, which is not a transcript item, so
      // the item stream the watcher sees never carries them.
      //
      // A subtask with nothing but a cost is still recorded. A stage that only
      // thought — a planning session that replied without calling a tool — used to
      // be indistinguishable from one that never ran, and it is precisely the kind
      // of stage whose cost is being questioned.
      const activity = (): SubtaskActivity | undefined => {
        const measured = session.costUsd !== undefined || session.tokenTotals !== undefined;
        if (activityWatcher.isEmpty() && !measured) return undefined;
        return {
          ...activityWatcher.result(),
          ...(session.costUsd !== undefined ? { costUsd: session.costUsd } : {}),
          ...(session.tokenTotals ? { tokens: session.tokenTotals } : {}),
          // What ran, not what was asked for. A model an org policy disallows is
          // substituted without failing, and a stage comparison against the
          // requested name would then be comparing two runs of the same model.
          ...(session.activeModel ? { actualModel: session.activeModel } : {}),
        };
      };

      // The environment check. It runs on the init event, which the CLI emits
      // once its MCP servers have been connected and before the model acts, so a
      // stage whose tools are missing is abandoned having spent startup time and
      // no inference. Letting it proceed is worse than it sounds: the agent does
      // not report that it lacked a tool, it does the job without it — reading a
      // ticket it cannot fetch by inventing plausible contents.
      const onMcp = (report: McpStartupReport) => {
        const required = options?.requiredMcpServers ?? [];
        if (required.length === 0) return;
        const readiness = assessMcpReadiness(required, report.servers, report.errors);
        if (readiness.ok) return;
        this.logger.error(
          `Harness [${task.name}] ${label} cannot start: ${readiness.reason}. ` +
            "Check the project's MCP config and the route's requiredMcpServers.",
        );
        this.sessions.stop(task.id);
        finish({
          ok: false,
          text: "",
          sessionId: session.sessionId,
          error: readiness.reason,
          denials: denials(),
          activity: activity(),
        });
      };

      const lastAssistantText = (): string => {
        const reply = [...session.items]
          .reverse()
          .find((item) => item.kind === "assistant");
        // Redacted because this is persisted as the subtask's reply and rendered in
        // its report. An agent that ran a deployment routinely quotes the command
        // it ran back at you, connection string and all.
        return reply && "text" in reply ? redactSecrets(reply.text) : "";
      };

      const onStatus = (status: string) => {
        // The turn is over when the session goes idle or dies. "waiting" means it
        // finished and wants more input; there is no more input for a subtask.
        if (status === "waiting") {
          const errored = session.lastTurnErrored;
          finish({
            ok: !errored,
            text: lastAssistantText(),
            sessionId: session.sessionId,
            // The CLI's own account of it, not a generic sentence. This string is
            // the stage's failure reason: it lands on the row, in the report and in
            // the log, and is the only thing a reader has to go on.
            error: errored
              ? (session.lastTurnError ?? "the agent reported an error")
              : undefined,
            denials: denials(),
            activity: activity(),
          });
          return;
        }
        if (status === "failed" || status === "stopped") {
          const text = lastAssistantText();
          // A stopped session that produced a reply is still a usable result;
          // only treat it as a failure when there is nothing to show.
          finish({
            ok: status === "stopped" && text.length > 0,
            text,
            sessionId: session.sessionId,
            // `session stopped` on its own is a failure message carrying no
            // information: a colleague's suggestion scan reported exactly that and
            // there was nothing to act on. An unavailable MCP server has its own
            // message and so does a timeout, so this path is everything else — which
            // is when the CLI's own account of how it exited is the only account
            // there is.
            error:
              text.length > 0
                ? undefined
                : `session ${status} — ${session.exitDetail ?? "no exit detail was recorded"}`,
            denials: denials(),
            activity: activity(),
          });
        }
      };

      session.on("status", onStatus);
      session.on("item", onItem);
      session.on("mcp", onMcp);
      // Items already buffered before this listener attached still count.
      for (const item of session.items) onItem(item);
    });
  }
}

/**
 * How far a subtask got, for a failure line. Deliberately short: this goes in a
 * log, and the report is where the detail lives.
 */
function describeProgress(activity: SubtaskActivity | undefined): string {
  if (!activity) return "no activity recorded";
  const tools = Object.entries(activity.toolCounts ?? {}).reduce(
    (total, [, count]) => total + count,
    0,
  );
  const parts = [`${tools} tool call(s)`];
  const written = activity.pathsWritten?.length ?? 0;
  if (written > 0) parts.push(`${written} file(s) written`);
  const commands = activity.commands?.length ?? 0;
  if (commands > 0) parts.push(`${commands} command(s) run`);
  return parts.join(", ");
}
