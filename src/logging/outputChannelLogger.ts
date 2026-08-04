import * as vscode from "vscode";
import { Logger, formatLogError } from "./logger";

/** Logger backed by a VS Code output channel. */
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
      this.channel.error(`${message}\n${formatLogError(error)}`);
    }
  }

  debug(message: string): void {
    this.channel.debug(message);
  }

  show(): void {
    this.channel.show(true);
  }
}
