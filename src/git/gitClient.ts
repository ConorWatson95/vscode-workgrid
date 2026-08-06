import { execFile } from "node:child_process";
import { Result, ok, err } from "../utilities/result";
import { Logger } from "../logging/logger";

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly args: string[],
    /**
     * What the command printed before failing.
     *
     * Kept because a non-zero exit is not always empty-handed: `git merge` reports
     * every conflicting path on *stdout* and then exits 1, so a failure carrying
     * only stderr loses the one thing a caller needs to say what conflicted.
     * Optional, since most callers of most commands have no use for it.
     */
    readonly stdout: string = "",
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
  /**
   * True when a non-zero exit is a meaningful answer rather than a fault.
   *
   * `show-ref --verify --quiet` exits 1 to say a branch does not exist, and
   * `rev-parse --is-inside-work-tree` fails to say a folder is not a repository.
   * Both are questions, correctly answered. Logging them as errors puts a red
   * line in the log for nothing going wrong, which sends people looking for a
   * fault that never happened — so such runs are logged at debug instead. The
   * `Result` is unchanged either way; only the log level differs.
   */
  failureIsAnswer?: boolean;
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
            const report = options.failureIsAnswer
              ? (text: string) => this.logger.debug(text)
              : (text: string) => this.logger.error(text);
            report(`git ${args.join(" ")} failed: ${message}`);
            resolve(err(new GitError(message, exitCode, stderr, args, stdout)));
            return;
          }

          resolve(ok({ stdout, stderr }));
        },
      );
    });
  }
}
