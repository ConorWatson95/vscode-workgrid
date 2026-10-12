import { ok } from "../utilities/result";
import { HarnessControlService } from "../services/harnessControlService";
import { SuggestionBoard, SuggestionControlService } from "../services/suggestionControlService";
import { RunSnapshot, RunSummary, StageView } from "../ui/harnessSnapshot";
import { GROUP_ORDER } from "../ui/taskGrouping";

/**
 * MCP server exposing the harness to Claude as a client: read tools for the model,
 * and a dashboard (an MCP App) whose buttons are the only way to record a decision.
 *
 * Transport-free: `handle` takes one parsed JSON-RPC message and returns the reply,
 * so every rule here is testable without a process. `main.ts` owns stdio.
 *
 * **Decisions are app-only, and only offered to a host that can show the app.** A
 * decision tool carries `visibility: ["app"]`, which a host implementing MCP Apps
 * must keep out of the model's tool list — so approving is a person pressing a
 * button over the evidence, never the model concluding that something looks fine.
 * A host that does not advertise the UI extension does not implement that rule
 * either, and would hand the model an `approve` tool; so for such a host the
 * decision tools are not registered at all and it gets the read tools only.
 *
 * The revision a decision must carry travels in `structuredContent`, which the spec
 * keeps out of model context, and never in the text the model reads.
 */

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const APP_MIME_TYPE = "text/html;profile=mcp-app";
export const DASHBOARD_URI = "ui://task-workspaces/harness-dashboard.html";

/** Newest first; the first one the client also speaks is the one used. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** A full stage report can run to tens of thousands of characters. */
export const MAX_REPORT_CHARS = 40_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ServerLog {
  info(message: string): void;
}

export class HarnessMcpServer {
  /** Set from the client's `initialize`; decides whether decision tools exist. */
  private appCapable = false;

  constructor(
    private readonly service: HarnessControlService,
    private readonly dashboardHtml: string,
    private readonly info: { name: string; version: string; repositoryRoot: string },
    private readonly log?: ServerLog,
    /** Whether answering a question that joined the brief also starts the route. */
    private readonly advanceAfterAnswering?: () => boolean,
    /** Suggested work. Absent means the tools for it are not offered. */
    private readonly suggestions?: SuggestionControlService,
  ) {}

  /** Replies to a request; `undefined` for a notification, which gets no reply. */
  async handle(message: JsonRpcMessage): Promise<object | undefined> {
    const isRequest = message.id !== undefined && message.id !== null;
    try {
      const result = await this.dispatch(message.method ?? "", message.params ?? {});
      return isRequest ? { jsonrpc: "2.0", id: message.id, result } : undefined;
    } catch (error) {
      if (!isRequest) return undefined;
      const known = error instanceof RpcError;
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: known ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.tools() };
      case "tools/call":
        return this.callTool(params);
      case "resources/list":
        return {
          resources: [
            {
              uri: DASHBOARD_URI,
              name: "Engineering Harness dashboard",
              mimeType: APP_MIME_TYPE,
            },
          ],
        };
      case "resources/read":
        if (params.uri !== DASHBOARD_URI) {
          throw new RpcError(-32002, `No resource ${String(params.uri)}.`);
        }
        return {
          contents: [
            {
              uri: DASHBOARD_URI,
              mimeType: APP_MIME_TYPE,
              text: this.dashboardHtml,
              // No `csp`: the page loads nothing from anywhere, so the host's
              // restrictive default is exactly right.
              _meta: { ui: { prefersBorder: true } },
            },
          ],
        };
      default:
        // An empty success rather than "method not found", which is what the
        // `ask_user` server does and what CLI 2.1.294 was probed against: it opens
        // with `server/discover`, and a server answering it with an error is one
        // that has never been checked against that fallback path.
        return {};
    }
  }

  private initialize(params: Record<string, unknown>): unknown {
    const capabilities = (params.capabilities ?? {}) as Record<string, unknown>;
    const extensions = (capabilities.extensions ?? {}) as Record<string, unknown>;
    const ui = extensions[UI_EXTENSION] as { mimeTypes?: unknown } | undefined;
    this.appCapable =
      Array.isArray(ui?.mimeTypes) && (ui!.mimeTypes as unknown[]).includes(APP_MIME_TYPE);
    this.log?.info(
      `initialize from ${JSON.stringify(params.clientInfo ?? {})}; ` +
        `MCP Apps ${this.appCapable ? "supported — decision tools offered" : "not advertised — read-only"}.`,
    );

    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        extensions: { [UI_EXTENSION]: {} },
      },
      serverInfo: { name: this.info.name, version: this.info.version },
      instructions:
        `Engineering Harness for ${this.info.repositoryRoot}. Use harness_dashboard to show ` +
        "the operator a run. The harness owns every outcome: you can read runs, stages and " +
        "reports, but approving, retrying and ticking verification items are decisions the " +
        "operator makes with the dashboard's buttons. Never tell them a stage is approved " +
        "because its report reads well.",
    };
  }

  private tools(): ToolDefinition[] {
    const ui = (visibility: string[]) => ({ ui: { resourceUri: DASHBOARD_URI, visibility } });
    const appOnly = { ui: { visibility: ["app"] } };
    const read: ToolDefinition[] = [
      {
        name: "harness_dashboard",
        title: "Show Engineering Harness",
        description:
          "Shows the operator an interactive board of every harness run, grouped by what each " +
          "needs — what is waiting on them first — from which they open a run to act on it. " +
          "Pass taskId to open on one run.",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "string", description: "A task id from harness_list_runs." } },
        },
        _meta: ui(["model", "app"]),
      },
      {
        name: "harness_list_runs",
        title: "List harness runs",
        description: "Lists the routed tasks in this repository and what each is waiting on.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "harness_get_run",
        title: "Get a harness run",
        description:
          "One run's stages, statuses, evidence, outstanding verification items, open " +
          "questions and declined work, as text. Omit taskId for the default run.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" } } },
      },
      {
        name: "harness_get_stage_report",
        title: "Get a stage's report",
        description:
          "The full report of one stage — what it ran, wrote and said — as the extension " +
          "renders it. Large; ask for it only when the summary is not enough.",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "string" }, stageId: { type: "string" } },
          required: ["taskId", "stageId"],
        },
      },
    ];
    if (this.suggestions) {
      read.push({
        name: "harness_list_suggestions",
        title: "List suggested work",
        description:
          "Work the project's configured sources (a ticket board, say) are holding that no " +
          "task has started yet, ranked as the source orders it, from the last scan. Says " +
          "how old the scan is and whether one is running.",
        inputSchema: { type: "object", properties: {} },
      });
    }
    if (!this.appCapable) return read;
    const suggestionTools: ToolDefinition[] = this.suggestions
      ? [
          {
            name: "harness_scan_suggestions",
            title: "Scan for work",
            description:
              "Dashboard-only: starts a scan of every configured source in a headless runner. " +
              "A scan is a paid session; the list updates when it finishes.",
            inputSchema: { type: "object", properties: {} },
            _meta: appOnly,
          },
          {
            name: "harness_task_options",
            title: "New task options",
            description: "Dashboard-only: the routes, branch types and base branches a new task can use.",
            inputSchema: { type: "object", properties: {} },
            _meta: appOnly,
          },
          {
            name: "harness_start_task",
            title: "Start a task from a suggestion",
            description:
              "Dashboard-only: creates the worktree and branch for one suggestion and attaches the chosen route.",
            inputSchema: {
              type: "object",
              properties: {
                sourceId: { type: "string" },
                ref: { type: "string" },
                name: { type: "string" },
                branchPrefix: { type: "string" },
                baseBranch: { type: "string" },
                routeId: { type: "string", description: "Omit for a chat task with no route." },
                assessFirst: { type: "boolean" },
                brief: { type: "string" },
              },
              required: ["sourceId", "ref", "name", "branchPrefix", "baseBranch"],
            },
            _meta: appOnly,
          },
        ]
      : [];

    return [
      ...read,
      {
        name: "harness_refresh",
        title: "Refresh dashboard",
        description: "Dashboard-only: the run list and one run's snapshot.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" } } },
        _meta: appOnly,
      },
      {
        name: "harness_approve_stage",
        title: "Approve stage",
        description: "Dashboard-only: records the operator approving a gate.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            stageId: { type: "string" },
            revision: { type: "string" },
            note: { type: "string" },
          },
          required: ["taskId", "stageId", "revision"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_retry_stage",
        title: "Retry stage",
        description: "Dashboard-only: re-opens a failed stage, discarding nothing.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            stageId: { type: "string" },
            revision: { type: "string" },
          },
          required: ["taskId", "stageId", "revision"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_set_checklist_item",
        title: "Tick verification item",
        description: "Dashboard-only: records the operator confirming, or withdrawing, one item.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            itemId: { type: "string" },
            checked: { type: "boolean" },
          },
          required: ["taskId", "itemId", "checked"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_correct_stage",
        title: "Fix stage",
        description: "Dashboard-only: files the operator's finding as a correction to a stage that ran.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            stageId: { type: "string" },
            revision: { type: "string" },
            finding: { type: "string" },
          },
          required: ["taskId", "stageId", "revision", "finding"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_rerun_stage",
        title: "Re-run stage",
        description: "Dashboard-only: discards a stage and everything after it, with the operator's reason.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            stageId: { type: "string" },
            revision: { type: "string" },
            reason: { type: "string" },
          },
          required: ["taskId", "stageId", "revision"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_send_back",
        title: "Send back",
        description: "Dashboard-only: sends a stage's findings to an earlier stage the route allows.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            fromStageId: { type: "string" },
            targetStageId: { type: "string" },
            revision: { type: "string" },
            how: { type: "string", enum: ["fix", "rerun"] },
            findings: { type: "string" },
            note: { type: "string" },
          },
          required: ["taskId", "fromStageId", "targetStageId", "revision", "how"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_answer_questions",
        title: "Answer questions",
        description:
          "Dashboard-only: records the operator's answers to a stage's questions. A stage " +
          "still waiting receives them mid-turn; otherwise they join the brief.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            askedAt: { type: "string" },
            answers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["taskId", "askedAt", "answers"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_decide_held_call",
        title: "Allow or deny a held tool call",
        description:
          "Dashboard-only: allows or denies a tool call the running stage is blocked on. " +
          "The process running the stage applies it and the stage carries on mid-turn.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            callId: { type: "string" },
            allow: { type: "boolean" },
            scope: { type: "string", enum: ["once", "session"] },
          },
          required: ["taskId", "callId", "allow"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_advance_route",
        title: "Advance route",
        description: "Dashboard-only: starts the route advancing in a headless runner.",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
        },
        _meta: appOnly,
      },
      {
        name: "harness_stop_route",
        title: "Stop route",
        description:
          "Dashboard-only: asks whichever process is advancing the route to stop at its current step.",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
        },
        _meta: appOnly,
      },
      ...suggestionTools,
    ];
  }

  private async callTool(params: Record<string, unknown>): Promise<CallResult> {
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);

    if (!this.tools().some((tool) => tool.name === name)) {
      return failure(`No tool "${name}".`);
    }

    switch (name) {
      case "harness_dashboard":
      case "harness_refresh": {
        // A run only when one is named: the board is what opens, and a run is a place the
        // operator goes from it, so guessing one would put a task in front of them they
        // did not choose.
        const taskId = text("taskId");
        const [runs, run, suggestions] = await Promise.all([
          this.service.listRuns(),
          taskId ? this.service.getRun(taskId) : Promise.resolve(undefined),
          this.suggestions?.board(),
        ]);
        return {
          content: [
            {
              type: "text",
              text:
                name === "harness_refresh"
                  ? "Refreshed."
                  : run
                    ? `Showing "${run.name}" to the operator.\n\n${describeRun(run)}`
                    : runs.length
                      ? `Showing the operator the board of ${runs.length} run(s).\n\n${describeBoard(runs)}`
                      : "No routed tasks in this repository.",
            },
          ],
          structuredContent: {
            repositoryRoot: this.info.repositoryRoot,
            runs,
            run: run ?? null,
            suggestions: suggestions ?? null,
          },
        };
      }
      case "harness_list_runs": {
        const runs = await this.service.listRuns();
        return {
          content: [{ type: "text", text: runs.length ? runs.map(describeSummary).join("\n") : "No routed tasks." }],
        };
      }
      case "harness_get_run": {
        const run = await this.service.getRun(text("taskId"));
        return run
          ? { content: [{ type: "text", text: describeRun(run) }] }
          : failure("No such run.");
      }
      case "harness_get_stage_report": {
        const report = await this.service.getStageReport(text("taskId") ?? "", text("stageId") ?? "");
        if (report === undefined) return failure("No such task or stage.");
        return {
          content: [
            {
              type: "text",
              text:
                report.length <= MAX_REPORT_CHARS
                  ? report
                  : `${report.slice(0, MAX_REPORT_CHARS)}\n\n… report truncated: ` +
                    `${report.length - MAX_REPORT_CHARS} more characters. Open it in VS Code ` +
                    "(Show What This Stage Did) for the rest.",
            },
          ],
        };
      }
      case "harness_approve_stage":
        return decision(
          await this.service.approveStage(
            text("taskId") ?? "",
            text("stageId") ?? "",
            text("revision") ?? "",
            text("note"),
          ),
        );
      case "harness_retry_stage":
        return decision(
          await this.service.retryStage(text("taskId") ?? "", text("stageId") ?? "", text("revision") ?? ""),
        );
      case "harness_set_checklist_item":
        return decision(
          await this.service.setChecklistItem(text("taskId") ?? "", text("itemId") ?? "", args.checked === true),
        );
      case "harness_correct_stage":
        return decision(
          await this.service.correctStage(
            text("taskId") ?? "",
            text("stageId") ?? "",
            text("revision") ?? "",
            text("finding") ?? "",
          ),
        );
      case "harness_rerun_stage":
        return decision(
          await this.service.rerunStage(
            text("taskId") ?? "",
            text("stageId") ?? "",
            text("revision") ?? "",
            text("reason"),
          ),
        );
      case "harness_send_back":
        return decision(
          await this.service.sendBack(text("taskId") ?? "", {
            fromStageId: text("fromStageId") ?? "",
            targetStageId: text("targetStageId") ?? "",
            revision: text("revision") ?? "",
            how: text("how") === "rerun" ? "rerun" : "fix",
            findings: text("findings"),
            note: text("note"),
          }),
        );
      case "harness_answer_questions": {
        const given = args.answers && typeof args.answers === "object" ? args.answers : {};
        const answers = Object.fromEntries(
          Object.entries(given as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        const taskId = text("taskId") ?? "";
        const answered = await this.service.answerQuestions(taskId, text("askedAt") ?? "", answers);
        // An answer that joined the brief leaves the stage pending, and the operator
        // answered so that it would run. The same setting VS Code's answer command
        // reads decides whether it does so without a second click.
        if (!answered.ok || !answered.value.readyToAdvance || !this.advanceAfterAnswering?.()) {
          return decision(answered);
        }
        const advanced = await this.service.advance(taskId);
        const then = advanced.ok ? advanced.value.message : `Not advanced: ${advanced.error.message}`;
        return decision(ok({ ...answered.value, message: `${answered.value.message} ${then}` }));
      }
      case "harness_decide_held_call":
        return decision(
          await this.service.decideHeldCall(
            text("taskId") ?? "",
            text("callId") ?? "",
            args.allow === true,
            text("scope") === "session" ? "session" : "once",
          ),
        );
      case "harness_advance_route":
        return decision(await this.service.advance(text("taskId") ?? ""));
      case "harness_stop_route":
        return decision(await this.service.stop(text("taskId") ?? ""));
      case "harness_list_suggestions": {
        const board = await this.suggestions!.board();
        return { content: [{ type: "text", text: describeSuggestions(board) }] };
      }
      case "harness_scan_suggestions": {
        const scanned = await this.suggestions!.startScan();
        if (!scanned.ok) return decision(scanned);
        return {
          content: [{ type: "text", text: scanned.value.message }],
          structuredContent: { ok: true, changed: true, message: scanned.value.message },
        };
      }
      case "harness_task_options": {
        const options = await this.suggestions!.options();
        return {
          content: [{ type: "text", text: `${options.routes.length} route(s).` }],
          structuredContent: { ...options },
        };
      }
      case "harness_start_task": {
        const started = await this.suggestions!.startTask({
          sourceId: text("sourceId") ?? "",
          ref: text("ref") ?? "",
          name: text("name") ?? "",
          branchPrefix: text("branchPrefix") ?? "",
          baseBranch: text("baseBranch") ?? "",
          routeId: text("routeId") || undefined,
          assessFirst: args.assessFirst === true,
          brief: text("brief"),
        });
        if (!started.ok) return decision(started);
        return {
          content: [{ type: "text", text: started.value.message }],
          structuredContent: {
            ok: true,
            changed: true,
            message: started.value.message,
            taskId: started.value.task.id,
            routed: !!started.value.task.pipeline,
          },
        };
      }
    }
    return failure(`No tool "${name}".`);
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function failure(message: string): CallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function decision(
  outcome: Awaited<ReturnType<HarnessControlService["approveStage"]>>,
): CallResult {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: outcome.error.message }],
      structuredContent: { ok: false, kind: outcome.error.kind, message: outcome.error.message },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: outcome.value.message }],
    structuredContent: { ok: true, changed: outcome.value.changed, message: outcome.value.message },
  };
}

const GLYPH: Record<StageView["state"], string> = {
  done: "✓",
  skipped: "–",
  running: "●",
  pending: "○",
  failed: "!",
  awaiting: "?",
  held: "?",
};

function describeSummary(run: RunSummary): string {
  const { need, status, since } = run.attention;
  return (
    `- ${run.ticket ? `${run.ticket} ` : ""}${run.name} [${run.taskId}] — ${run.groupLabel}: ` +
    (need ?? status) +
    (since ? ` (since ${since})` : "") +
    ` · ${run.progress.done}/${run.progress.total} stages` +
    (run.route ? ` · ${run.route}` : "")
  );
}

/** The board as the model reads it: grouped as the operator sees it, worst first. */
export function describeBoard(runs: readonly RunSummary[]): string {
  return GROUP_ORDER.map((group) => runs.filter((run) => run.group === group))
    .filter((members) => members.length > 0)
    .map((members) => `${members[0].groupLabel} (${members.length}):\n${members.map(describeSummary).join("\n")}`)
    .join("\n\n");
}

/** The suggestion list as the model reads it: ranked, hidden items counted not listed. */
export function describeSuggestions(board: SuggestionBoard): string {
  if (!board.configured) return "No suggestion sources are configured for this project.";
  const lines: string[] = [];
  if (board.scanningSince) lines.push(`A scan is running (since ${board.scanningSince}).`);
  if (!board.scannedAt) {
    lines.push("No scan has been run yet. The operator can scan from the dashboard.");
    return lines.join("\n");
  }
  lines.push(`Last scanned ${board.scannedAt}.`);
  for (const failure of board.failures) lines.push(`Source failed — ${failure}`);
  const shown = board.suggestions.filter((item) => !item.hidden);
  const hidden = board.suggestions.length - shown.length;
  if (shown.length === 0) lines.push("Nothing outstanding above the rank filter.");
  for (const item of shown) {
    lines.push(
      `- ${item.ref} — ${item.title}` +
        (item.rank ? ` · ${item.rank}` : "") +
        (item.state ? ` · ${item.state}` : "") +
        (item.url ? ` · ${item.url}` : ""),
    );
  }
  if (hidden > 0) lines.push(`${hidden} more below the source's rank filter.`);
  return lines.join("\n");
}

/** The model's view of a run: what it says, without the revision or the buttons. */
export function describeRun(run: RunSnapshot): string {
  const lines = [
    `${run.name} [${run.taskId}] — ${run.groupLabel}`,
    `Route: ${run.route ?? "none"} · branch ${run.branch}`,
  ];
  if (run.inFlight) lines.push(`A session is running on "${run.inFlight}".`);
  for (const call of run.heldCalls) {
    lines.push(`Waiting for permission: ${call.tool} — ${call.detail}${call.decided ? " (decided, on its way)" : ""}`);
  }
  lines.push("", "Stages:");
  for (const stage of run.stages) {
    lines.push(
      `${GLYPH[stage.state]} ${stage.name} [${stage.id}] — ${stage.statusLabel}` +
        (stage.detail ? ` · ${stage.detail}` : ""),
    );
    if (stage.state !== "pending" && stage.evidence.basis !== "none") {
      // The full self-reported sentence is advice to whoever configures the route,
      // identical on most stages; repeated per stage it was most of what a model read.
      // The route-wide evidence line below says the same thing once.
      lines.push(
        `    evidence: ${stage.evidence.selfReported ? "self-reported only" : stage.evidence.summary}`,
      );
    }
    if (stage.held) lines.push(`    held: ${stage.held}`);
    if (stage.failure) lines.push(`    failed: ${stage.failure.split("\n")[0]}`);
    const holding = stage.checklist.filter((item) => item.holding);
    for (const item of holding) lines.push(`    needs a person: ${item.text}`);
  }
  if (run.question?.items.length) {
    lines.push("", `Open question from "${run.question.stageName}":`);
    for (const item of run.question.items) lines.push(`- ${item}`);
  }
  if (run.deferrals.length) {
    lines.push("", "Declined work nobody owns yet:");
    for (const item of run.deferrals) lines.push(`- ${item.text} (raised by ${item.raisedBy})`);
  }
  if (run.evidenceLine) lines.push("", run.evidenceLine);
  return lines.join("\n");
}
