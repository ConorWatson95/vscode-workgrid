import { HarnessControlService } from "../services/harnessControlService";
import { RunSnapshot, RunSummary, StageView } from "../ui/harnessSnapshot";

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
          "Shows the operator an interactive dashboard of one harness run: every stage, its " +
          "status, the evidence behind it, and anything waiting on a person. Omit taskId for " +
          "the run most likely to need attention.",
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
    if (!this.appCapable) return read;

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
        const [runs, run] = await Promise.all([
          this.service.listRuns(),
          this.service.getRun(text("taskId")),
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
                    : "No routed tasks in this repository.",
            },
          ],
          structuredContent: { repositoryRoot: this.info.repositoryRoot, runs, run: run ?? null },
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
  return (
    `- ${run.name} [${run.taskId}] — ${run.groupLabel}` +
    (run.currentStage ? `, at "${run.currentStage}"` : "") +
    (run.route ? ` (${run.route})` : "")
  );
}

/** The model's view of a run: what it says, without the revision or the buttons. */
export function describeRun(run: RunSnapshot): string {
  const lines = [
    `${run.name} [${run.taskId}] — ${run.groupLabel}`,
    `Route: ${run.route ?? "none"} · branch ${run.branch}`,
  ];
  if (run.inFlight) lines.push(`A session is running on "${run.inFlight}".`);
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
