import * as vscode from "vscode";

export const DIFF_SCHEME = "taskworkspaces-diff";

/**
 * Serves task diffs as read-only virtual documents so they render in a normal
 * editor with `diff` syntax highlighting, without needing the worktree open as
 * a workspace folder.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly content = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }

  /** Builds a stable, titled URI for a task's diff. */
  uriFor(taskId: string, taskName: string): vscode.Uri {
    const safe = taskName.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${safe}.diff`, query: taskId });
  }

  set(uri: vscode.Uri, content: string): void {
    this.content.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
