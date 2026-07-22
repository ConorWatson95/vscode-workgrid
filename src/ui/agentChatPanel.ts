import * as vscode from "vscode";
import { ClaudeStreamSession } from "../agents/claudeStreamSession";
import { ChatItem } from "../agents/streamJson";
import { AgentSessionStatus } from "../domain/agentSession";
import { ProviderVisual } from "../agents/agentProviderMeta";

export interface HistoryEntry {
  id: string;
  title: string;
  mtimeMs: number;
  archived: boolean;
}

/** How the panel drives session operations without knowing the wiring. */
export interface ChatController {
  currentMode(): string;
  /** Restart at a new permission mode; returns the new session, or undefined if unsupported (read-only). */
  setMode(mode: string): ClaudeStreamSession | undefined;
  listHistory(): Promise<HistoryEntry[]>;
  openHistory(
    entry: HistoryEntry,
  ): Promise<{ session?: ClaudeStreamSession; items?: ChatItem[]; readOnly: boolean; title: string }>;
}

export interface ChatPanelOptions {
  provider: ProviderVisual;
  completions: { slash: string[]; files: string[] };
  controller: ChatController;
  /** When set, the panel opens read-only showing these items (archived view). */
  initialReadOnly?: { title: string; items: ChatItem[] };
}

/**
 * A Webview panel rendering a task's Claude session with a chat transcript,
 * input box, permission-mode switcher and session-history browser. One panel
 * per task; the live session can be swapped (mode change / resume) in place.
 */
export class AgentChatPanel {
  private static readonly panels = new Map<string, AgentChatPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private session: ClaudeStreamSession | undefined;
  private readOnly = false;
  private readOnlyView: { title: string; items: ChatItem[] } | undefined;
  private readonly onItem = (item: ChatItem) =>
    void this.panel.webview.postMessage({ type: "item", item });
  private readonly onStatus = (status: AgentSessionStatus) =>
    void this.panel.webview.postMessage({ type: "status", status, busy: this.session?.busy ?? false });

  static show(
    taskId: string,
    taskName: string,
    session: ClaudeStreamSession | undefined,
    extensionUri: vscode.Uri,
    options: ChatPanelOptions,
  ): void {
    const existing = AgentChatPanel.panels.get(taskId);
    if (existing) {
      if (session) existing.attach(session);
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "taskWorkspaces.chat",
      `${options.provider.displayName} · ${taskName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    AgentChatPanel.panels.set(
      taskId,
      new AgentChatPanel(taskId, taskName, panel, session, extensionUri, options),
    );
  }

  private constructor(
    private readonly taskId: string,
    private readonly taskName: string,
    private readonly panel: vscode.WebviewPanel,
    session: ClaudeStreamSession | undefined,
    extensionUri: vscode.Uri,
    private readonly options: ChatPanelOptions,
  ) {
    this.session = session;
    if (options.initialReadOnly) {
      this.readOnly = true;
      this.readOnlyView = options.initialReadOnly;
    }
    this.panel.webview.html = this.render(this.panel.webview, extensionUri);
    if (session) this.bind(session);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: { type: string; text?: string; mode?: string; entry?: HistoryEntry }) =>
        this.handleMessage(msg),
      ),
    );

    this.panel.onDidDispose(() => {
      this.unbind();
      for (const d of this.disposables) d.dispose();
      AgentChatPanel.panels.delete(this.taskId);
      // The session itself is left running so it can be re-opened.
    });
  }

  /** Binds listeners to a live session (removing any previous binding). */
  private bind(session: ClaudeStreamSession): void {
    this.unbind();
    this.session = session;
    session.on("item", this.onItem);
    session.on("status", this.onStatus);
  }

  private unbind(): void {
    this.session?.off("item", this.onItem);
    this.session?.off("status", this.onStatus);
  }

  /** Swaps in a new live session and refreshes the view. */
  private attach(session: ClaudeStreamSession): void {
    this.readOnly = false;
    this.readOnlyView = undefined;
    this.bind(session);
    this.postInit();
  }

  private async handleMessage(msg: { type: string; text?: string; mode?: string; entry?: HistoryEntry }): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postInit();
        break;
      case "send":
        if (msg.text && !this.readOnly) this.session?.send(msg.text);
        break;
      case "stop":
        this.session?.stop();
        break;
      case "setMode": {
        if (!msg.mode) break;
        const s = this.options.controller.setMode(msg.mode);
        if (s) this.attach(s);
        break;
      }
      case "history": {
        const entries = await this.options.controller.listHistory();
        void this.panel.webview.postMessage({
          type: "history",
          entries,
          currentMode: this.options.controller.currentMode(),
        });
        break;
      }
      case "openHistory": {
        if (!msg.entry) break;
        const r = await this.options.controller.openHistory(msg.entry);
        if (r.session) {
          this.readOnlyView = undefined;
          this.attach(r.session);
        } else {
          this.readOnly = true;
          this.unbind();
          this.session = undefined;
          this.readOnlyView = { title: r.title, items: r.items ?? [] };
          this.postInit();
        }
        break;
      }
    }
  }

  private postInit(): void {
    const items = this.session?.items ?? this.readOnlyView?.items ?? [];
    void this.panel.webview.postMessage({
      type: "init",
      title: this.readOnlyView?.title ?? this.taskName,
      provider: this.options.provider,
      completions: this.options.completions,
      items,
      status: this.session?.status ?? "stopped",
      busy: this.session?.busy ?? false,
      currentMode: this.options.controller.currentMode(),
      readOnly: this.readOnly,
    });
  }

  private render(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="header">
    <span id="badge"></span>
    <span id="title">Claude</span>
    <select id="mode" title="Permission mode">
      <option value="default">Manual</option>
      <option value="acceptEdits">Edit automatically</option>
      <option value="plan">Plan</option>
      <option value="bypassPermissions">Auto</option>
    </select>
    <button id="history" class="ghost" title="Session history">History</button>
    <span id="pill" class="pill"><span class="dot"></span><span id="pill-label">Starting</span></span>
  </div>
  <div id="log"></div>
  <div id="typing"><span class="d"></span><span class="d"></span><span class="d"></span> Claude is working…</div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="Message Claude…"></textarea>
    <button id="send">Send</button>
    <button id="stop">Stop</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
