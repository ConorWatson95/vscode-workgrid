import { TaskWorkspace } from "../domain/taskWorkspace";
import { StreamSessionOptions } from "./claudeStreamSession";
import { ChatItem } from "./streamJson";
import { DenialWatcher, PermissionDenial } from "./permissionDenials";
import { StageActivityWatcher } from "./stageActivity";
import { SubtaskActivity } from "../domain/taskPipeline";
import { StageSessionRunner } from "../services/pipelineRunner";
import { Logger } from "../logging/logger";
import { redactSecrets } from "../domain/secretRedaction";

/** How often a running stage's progress is reported to whoever is watching. */
export const ACTIVITY_INTERVAL_MS = 1500;

/** The part of a live session a stage run observes. */
export interface StageSession {
  readonly items: readonly ChatItem[];
  readonly sessionId?: string;
  readonly lastTurnErrored: boolean;
  /** What the CLI said went wrong, when it did. */
  readonly lastTurnError?: string;
  on(event: "status", listener: (status: string) => void): unknown;
  on(event: "item", listener: (item: ChatItem) => void): unknown;
  off(event: "status", listener: (status: string) => void): unknown;
  off(event: "item", listener: (item: ChatItem) => void): unknown;
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
  /** Stops watching. Also tells any still-blocked hook that nobody is listening. */
  release(taskId: string): void;
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
        // The CLI has gone, so anything still holding is holding for nothing —
        // and a row the user could click but never satisfy is worse than none.
        if (gateSession) this.gate?.release(task.id);
        resolve(result);
      };

      const timer = setTimeout(() => {
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
          error: `timed out after ${minutes} minute(s)`,
          denials: denials(),
          activity: activity(),
        });
      }, this.timeoutMs);

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
      const activity = (): SubtaskActivity | undefined =>
        activityWatcher.isEmpty() ? undefined : activityWatcher.result();

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
            error: text.length > 0 ? undefined : `session ${status}`,
            denials: denials(),
            activity: activity(),
          });
        }
      };

      session.on("status", onStatus);
      session.on("item", onItem);
      // Items already buffered before this listener attached still count.
      for (const item of session.items) onItem(item);
    });
  }
}
