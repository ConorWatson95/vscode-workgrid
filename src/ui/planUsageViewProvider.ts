import * as vscode from "vscode";
import { PlanUsage, UsagePeriod, parseResetAt, formatResetIn } from "../agents/planUsage";

/** Data access the usage view needs, injected to keep it decoupled. */
export interface UsageViewDeps {
  /** Last known plan usage, or undefined if not probed yet. */
  getUsage(): PlanUsage | undefined;
  /** True while a usage probe is in flight. */
  isUsageRefreshing(): boolean;
  /** Probes usage (forced, or only when stale) and re-renders on completion. */
  refreshUsage(force: boolean): void;
}

/**
 * A dedicated sidebar view for plan usage.
 *
 * Kept separate from the task details view because usage is account-wide, not a
 * property of the selected task — it should stay put and stay readable however
 * the tree selection changes.
 */
export class PlanUsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "taskWorkspaces.usage";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: UsageViewDeps,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type !== "refreshUsage") return;
      this.deps.refreshUsage(true);
      this.render(); // reflect the in-flight state immediately
    });
    // Re-probe whenever the view becomes visible again.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
    this.render();
  }

  /** Re-renders, re-probing usage if the cached snapshot has gone stale. */
  refresh(): void {
    this.deps.refreshUsage(false);
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const webview = this.view.webview;
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "detail.css"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    webview.html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<style nonce="${nonce}">${this.widthRules()}</style>
</head>
<body class="view usage-view">
${this.body()}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("button[data-refresh]").forEach((b) =>
    b.addEventListener("click", () => vscode.postMessage({ type: "refreshUsage" })));
</script>
</body></html>`;
  }

  /**
   * Bar widths as real CSS rules. The CSP has no `'unsafe-inline'`, so a
   * `style="width:N%"` attribute would be dropped and the bar would fall back
   * to `auto` — i.e. render full.
   */
  private widthRules(): string {
    const pcts = new Set(this.percentages());
    return [...pcts].map((p) => `.usage-fill[data-pct="${p}"]{width:${p}%}`).join("\n");
  }

  private percentages(): number[] {
    return (this.deps.getUsage()?.lines ?? []).map((l) =>
      Math.max(0, Math.min(100, Math.round(l.percent))),
    );
  }

  private body(): string {
    const usage = this.deps.getUsage();
    const refreshing = this.deps.isUsageRefreshing();
    const header = `<div class="usage-header">
      <button class="linklike" data-refresh="usage" ${refreshing ? "disabled" : ""}
        title="Re-check usage">${refreshing ? "checking…" : "refresh"}</button>
    </div>`;

    if (!usage) {
      return `${header}<div class="usage-empty">${
        refreshing ? "Checking usage…" : "Usage unavailable."
      }</div>`;
    }

    const pcts = this.percentages();
    const bars = usage.lines
      .map((line, i) => {
        const pct = pcts[i];
        // Warn as the window fills; these thresholds are display-only.
        const tone = pct >= 90 ? " danger" : pct >= 75 ? " warn" : "";
        const resets = line.resets
          ? `<div class="usage-resets" title="${escapeHtml(line.resets)}">resets ${escapeHtml(
              resetLabel(line.resets),
            )}</div>`
          : "";
        return `<div class="usage-row">
          <div class="usage-head">
            <span class="usage-label">${escapeHtml(line.label)}</span>
            <span class="usage-pct${tone}">${pct}%</span>
          </div>
          <div class="usage-bar"><div class="usage-fill${tone}" data-pct="${pct}"></div></div>
          ${resets}
        </div>`;
      })
      .join("");

    return `${header}
      <div class="usage">${bars}</div>
      ${driversSection(usage.periods)}
      <div class="usage-note">Approximate — local sessions on this machine only.
        Checked ${escapeHtml(new Date(usage.fetchedAt).toLocaleTimeString())}.</div>`;
  }
}

/**
 * What the CLI attributes usage to, per window.
 *
 * Called "Drivers" rather than a "split" or "breakdown" deliberately: the CLI
 * states these are independent characteristics, and they regularly sum past
 * 100% because one request can be long-context *and* subagent-heavy *and*
 * running in parallel. Bars would imply a partition, so these are plain
 * percentages.
 */
function driversSection(periods: UsagePeriod[]): string {
  if (periods.length === 0) return "";

  const blocks = periods
    .map((period, index) => {
      const counts = [
        period.requests === undefined ? "" : `${period.requests.toLocaleString()} requests`,
        period.sessions === undefined ? "" : `${period.sessions.toLocaleString()} sessions`,
      ]
        .filter(Boolean)
        .join(" · ");

      const factors = period.factors
        .map(
          (f) => `<div class="driver">
            <span class="driver-pct">${f.percent}%</span>
            <span class="driver-label">${escapeHtml(f.label)}</span>
          </div>`,
        )
        .join("");

      const lists = period.lists
        .map(
          (l) => `<div class="driver-list">
            <div class="driver-list-kind">Top ${escapeHtml(l.kind)}</div>
            ${l.entries
              .map(
                (e) => `<div class="driver">
                  <span class="driver-pct">${e.percent}%</span>
                  <span class="driver-label mono">${escapeHtml(e.name)}</span>
                </div>`,
              )
              .join("")}
          </div>`,
        )
        .join("");

      // The most recent window is the one usually wanted, so open it by default.
      return `<details class="driver-period" ${index === 0 ? "open" : ""}>
        <summary>${escapeHtml(period.label)}${counts ? `<span class="driver-counts">${escapeHtml(counts)}</span>` : ""}</summary>
        ${factors}${lists}
      </details>`;
    })
    .join("");

  return `<div class="drivers">
    <div class="drivers-title">Drivers</div>
    ${blocks}
    <div class="drivers-note">Independent characteristics, not a breakdown — these overlap and can total over 100%.</div>
  </div>`;
}

/** "in 2 days" where the CLI's text can be understood, else the text itself. */
function resetLabel(resets: string): string {
  const at = parseResetAt(resets);
  return at === undefined ? resets : `in ${formatResetIn(at)}`;
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
