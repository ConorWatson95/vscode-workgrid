/**
 * Minimal structured logging surface. Services depend on this interface, not on
 * the VS Code output channel directly, so they stay testable.
 *
 * The interface lives apart from any implementation on purpose: importing it
 * must not drag `vscode` in, or every module that logs would become
 * unreachable from a headless run and untestable under vitest. The VS Code
 * implementation is in `outputChannelLogger.ts`.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  debug(message: string): void;
  /** Reveals the log to the user. Optional so test fakes can omit it. */
  show?(): void;
}

/** Formats an optional error the way every implementation should. */
export function formatLogError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/**
 * Logger for runs with no editor attached. Levels go to the matching console
 * stream so a caller can separate diagnostics from output by redirecting
 * stderr.
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly debugEnabled = false) {}

  info(message: string): void {
    console.error(`info  ${message}`);
  }

  warn(message: string): void {
    console.error(`warn  ${message}`);
  }

  error(message: string, error?: unknown): void {
    console.error(
      error === undefined ? `error ${message}` : `error ${message}\n${formatLogError(error)}`,
    );
  }

  debug(message: string): void {
    if (this.debugEnabled) console.error(`debug ${message}`);
  }
}

/** Discards everything. For tests and for callers that do not want output. */
export class NullLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
}
