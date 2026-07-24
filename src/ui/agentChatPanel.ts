import * as vscode from "vscode";
import * as path from "node:path";
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
  /** Resume the current session after its process has ended, or undefined if unsupported (read-only). */
  resume(): ClaudeStreamSession | undefined;
  listHistory(): Promise<HistoryEntry[]>;
  openHistory(
    entry: HistoryEntry,
  ): Promise<{ session?: ClaudeStreamSession; items?: ChatItem[]; readOnly: boolean; title: string }>;
}

export interface ChatPanelOptions {
  provider: ProviderVisual;
  completions: { slash: string[]; files: string[] };
  controller: ChatController;
  /** Worktree root, used to scope the Attach-file picker and @-mention paths. */
  worktreePath: string;
  /** Prompt to compact once context exceeds this many tokens (0 = never). */
  compactThreshold: number;
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
  private readonly onTokens = (tokens: number) =>
    void this.panel.webview.postMessage({ type: "tokens", tokens });

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
    session.on("tokens", this.onTokens);
  }

  private unbind(): void {
    this.session?.off("item", this.onItem);
    this.session?.off("status", this.onStatus);
    this.session?.off("tokens", this.onTokens);
  }

  /** Swaps in a new live session and refreshes the view. */
  private attach(session: ClaudeStreamSession): void {
    this.readOnly = false;
    this.readOnlyView = undefined;
    this.bind(session);
    this.postInit();
  }

  /**
   * Sends a user turn. If the session's process has ended (failed/stopped),
   * transparently resume it first so a crashed or stopped chat can continue
   * instead of silently swallowing the message.
   */
  private sendOrResume(text: string): void {
    const dead =
      !this.session ||
      this.session.status === "failed" ||
      this.session.status === "stopped";
    if (dead) {
      const resumed = this.options.controller.resume();
      if (!resumed) return;
      this.attach(resumed);
      resumed.send(text);
      return;
    }
    this.session?.send(text);
  }

  private async handleMessage(msg: { type: string; text?: string; mode?: string; entry?: HistoryEntry }): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postInit();
        break;
      case "send":
        if (msg.text && !this.readOnly) this.sendOrResume(msg.text);
        break;
      case "stop":
        this.session?.stop();
        break;
      case "compact":
        this.session?.compact();
        break;
      case "attach":
        await this.attachFiles();
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
      tokens: this.session?.contextTokens ?? 0,
      compactThreshold: this.options.compactThreshold,
    });
  }

  /** Opens a file picker in the worktree and inserts @-mention references. */
  private async attachFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      defaultUri: vscode.Uri.file(this.options.worktreePath),
      openLabel: "Attach to context",
      title: "Attach files to Claude's context",
    });
    if (!uris || uris.length === 0) return;
    const refs = uris.map((u) => {
      const rel = path.relative(this.options.worktreePath, u.fsPath).replace(/\\/g, "/");
      // Files outside the worktree fall back to an absolute path.
      return "@" + (rel && !rel.startsWith("..") ? rel : u.fsPath.replace(/\\/g, "/"));
    });
    void this.panel.webview.postMessage({ type: "insert", text: refs.join(" ") + " " });
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
    <button id="compact" class="ghost" title="Compact the conversation context">Compact</button>
    <span id="tokens" class="tokens" title="Approximate context size (input + cache)"></span>
    <span id="pill" class="pill"><span class="dot"></span><span id="pill-label">Starting</span></span>
  </div>
  <div id="compact-banner"><span id="compact-text"></span><button id="compact-now">Compact now</button></div>
  <div id="log"></div>
  <div id="typing"><span class="d"></span><span class="d"></span><span class="d"></span> Claude is working…</div>
  <div id="composer">
    <button id="attach" class="icon" title="Attach files to context">＋</button>
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
