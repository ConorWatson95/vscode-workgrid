import * as vscode from "vscode";

/**
 * Associates VS Code integrated terminals with tasks and tracks their lifecycle.
 * Terminals close with the window, so agents launched this way stop on window
 * close — the safest MVP behaviour, with no orphaned processes.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly closeEmitter = new vscode.EventEmitter<string>();

  /** Fires with a taskId when that task's terminal is closed. */
  readonly onDidCloseTaskTerminal = this.closeEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        const taskId = this.findTaskId(terminal);
        if (taskId) {
          this.terminals.delete(taskId);
          this.closeEmitter.fire(taskId);
        }
      }),
    );
  }

  hasTerminal(taskId: string): boolean {
    return this.terminals.has(taskId);
  }

  getTerminal(taskId: string): vscode.Terminal | undefined {
    return this.terminals.get(taskId);
  }

  createTerminal(taskId: string, name: string, cwd: string): vscode.Terminal {
    const existing = this.terminals.get(taskId);
    if (existing) return existing;
    const terminal = vscode.window.createTerminal({ name, cwd });
    this.terminals.set(taskId, terminal);
    return terminal;
  }

  disposeTerminal(taskId: string): void {
    const terminal = this.terminals.get(taskId);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(taskId);
    }
  }

  private findTaskId(terminal: vscode.Terminal): string | undefined {
    for (const [taskId, t] of this.terminals) {
      if (t === terminal) return taskId;
    }
    return undefined;
  }

  dispose(): void {
    this.closeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
