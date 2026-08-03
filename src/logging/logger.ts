import * as vscode from "vscode";

/**
 * Minimal structured logging surface. Services depend on this interface, not on
 * the VS Code output channel directly, so they stay testable.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  debug(message: string): void;
  /** Reveals the log to the user. Optional so test fakes can omit it. */
  show?(): void;
}

export class OutputChannelLogger implements Logger {
  constructor(private readonly channel: vscode.LogOutputChannel) {}

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, error?: unknown): void {
    if (error === undefined) {
      this.channel.error(message);
    } else {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      this.channel.error(`${message}\n${detail}`);
    }
  }

  debug(message: string): void {
    this.channel.debug(message);
  }

  show(): void {
    this.channel.show(true);
  }
}
