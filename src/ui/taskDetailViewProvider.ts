import * as vscode from "vscode";
import { TaskWorkspace, TaskWorkspaceLiveState } from "../domain/taskWorkspace";
import { AgentActivity } from "./statusPresentation";
import { deriveTaskPhase, taskPhasePresentation } from "./taskPhase";

export type DetailAction =
  | "open"
  | "startNative"
  | "startChat"
  | "startTerminal"
  | "diff"
  | "copy"
  | "archive"
  | "unarchive"
  | "remove";

/** Data access the detail view needs, injected to keep it decoupled. */
export interface DetailViewDeps {
  getTask(id: string): Promise<TaskWorkspace | undefined>;
  getLiveState(task: TaskWorkspace): Promise<TaskWorkspaceLiveState>;
  getActivity(taskId: string): AgentActivity | undefined;
  run(taskId: string, action: DetailAction): void;
}

const PHASE_HEX: Record<string, string> = {
  "charts.purple": "#b180d7",
  "charts.blue": "#4aa3ff",
  "charts.yellow": "#e0b341",
  "charts.orange": "#e08c41",
  "charts.green": "#3fb950",
  "charts.red": "#f85149",
};

/**
 * A webview view docked in the Task Workspaces sidebar, showing details of the
 * currently selected task and updating as the selection changes.
 */
export class TaskDetailViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "taskWorkspaces.detail";

  private view: vscode.WebviewView | undefined;
  private currentTaskId: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: DetailViewDeps,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.onDidReceiveMessage((msg: { type: string; action?: DetailAction }) => {
      if (msg.type === "action" && msg.action && this.currentTaskId) {
        this.deps.run(this.currentTaskId, msg.action);
      }
    });
    void this.render();
  }

  /** Points the view at a task (called on tree selection). */
  show(taskId: string | undefined): void {
    this.currentTaskId = taskId;
    void this.render();
  }

  /** Re-renders the current task (called when task data changes). */
  refresh(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;

    if (!this.currentTaskId) {
      webview.html = this.wrap(webview, `<div class="empty">Select a task to see its details.</div>`);
      return;
    }
    const task = await this.deps.getTask(this.currentTaskId);
    if (!task) {
      webview.html = this.wrap(webview, `<div class="empty">Task not found.</div>`);
      return;
    }

    const live = await this.deps.getLiveState(task);
    const phase = deriveTaskPhase({
      activity: this.deps.getActivity(task.id),
      dirty: live.isDirty,
      commitsAhead: live.commitsAhead,
    });
    const p = taskPhasePresentation(phase);
    const color = p.colorId ? PHASE_HEX[p.colorId] : undefined;

    webview.html = this.wrap(webview, this.body(task, live, p.label, color), color);
  }

  private body(
    task: TaskWorkspace,
    live: TaskWorkspaceLiveState,
    phaseLabel: string,
    _color: string | undefined,
  ): string {
    const esc = escapeHtml;
    const fmt = (iso: string) => {
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toLocaleString();
    };
    const changePill = live.isDirty
      ? `<span class="pill warn">${live.changedFileCount} uncommitted change${live.changedFileCount === 1 ? "" : "s"}</span>`
      : `<span class="pill ok">clean</span>`;
    const aheadPill =
      live.commitsAhead > 0
        ? `<span class="pill">${live.commitsAhead} commit${live.commitsAhead === 1 ? "" : "s"} ahead</span>`
        : "";
    const lifecycle = task.status === "archived"
      ? `<button class="secondary" data-action="unarchive">Restore</button>`
      : `<button class="secondary" data-action="archive">Archive</button>`;
    const missing = live.worktreeExists
      ? ""
      : `<div class="warnbox">⚠️ Worktree not found — it may have been removed outside the extension.</div>`;

    return `
      <div class="head"><span class="dot"></span><h1>${esc(task.name)}</h1></div>
      <div class="phase">${esc(phaseLabel)}</div>
      ${task.description ? `<p class="desc">${esc(task.description)}</p>` : ""}

      <div class="section-title">Start Claude</div>
      <div class="actions">
        <button data-action="startNative" title="Open the worktree in a new window with the Claude extension">Extension</button>
        <button data-action="startChat" title="In-window chat panel">Chat panel</button>
        <button data-action="startTerminal" title="Integrated terminal">Terminal</button>
      </div>

      <div class="section-title">Workspace</div>
      <div class="actions">
        <button class="secondary" data-action="open">Open Folder</button>
        <button class="secondary" data-action="diff">Show Diff</button>
        <button class="secondary" data-action="copy">Copy Path</button>
        ${lifecycle}
        <button class="danger" data-action="remove">Remove</button>
      </div>

      <div class="section-title">Git</div>
      <div class="pills">${changePill}${aheadPill}</div>
      ${missing}

      <div class="section-title">Details</div>
      <dl>
        <dt>Status</dt><dd>${esc(task.status)}</dd>
        <dt>Branch</dt><dd class="mono">${esc(task.branchName)}</dd>
        <dt>Base</dt><dd class="mono">${esc(task.baseBranch)}</dd>
        <dt>Worktree</dt><dd class="mono">${esc(task.worktreePath)}</dd>
        ${task.agent ? `<dt>Agent</dt><dd>${esc(task.agent.provider)} (${esc(task.agent.status)})</dd>` : ""}
        <dt>Created</dt><dd>${esc(fmt(task.createdAt))}</dd>
        <dt>Updated</dt><dd>${esc(fmt(task.updatedAt))}</dd>
      </dl>`;
  }

  private wrap(webview: vscode.Webview, inner: string, color?: string): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "detail.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
</head>
<body class="view" style="${color ? `--phase-color:${color}` : ""}">
${inner}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("button[data-action]").forEach((b) =>
    b.addEventListener("click", () => vscode.postMessage({ type: "action", action: b.dataset.action })));
</script>
</body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
