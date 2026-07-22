import { execFile } from "node:child_process";
import { Result, ok, err } from "../utilities/result";
import { Logger } from "../logging/logger";

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Max buffer for stdout/stderr in bytes. Diffs can be large. */
  maxBuffer?: number;
}

/**
 * Thin wrapper around the git executable. All invocations use an argument array
 * via execFile (never a shell string) to avoid injection and Bash dependency.
 * Every call returns a Result — git failures are values, not thrown exceptions.
 */
export class GitClient {
  constructor(
    private readonly logger: Logger,
    private readonly gitPath: string = "git",
  ) {}

  run(args: string[], options: GitRunOptions): Promise<Result<GitRunResult, GitError>> {
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(
        this.gitPath,
        args,
        {
          cwd: options.cwd,
          signal: options.signal,
          maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const duration = Date.now() - started;
          this.logger.debug(`git ${args.join(" ")} (${duration}ms) cwd=${options.cwd}`);

          if (error) {
            const exitCode =
              typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
                ? ((error as unknown as { code: number }).code)
                : null;
            const message = stderr.trim() || error.message;
            this.logger.error(`git ${args.join(" ")} failed: ${message}`);
            resolve(err(new GitError(message, exitCode, stderr, args)));
            return;
          }

          resolve(ok({ stdout, stderr }));
        },
      );
    });
  }
}
