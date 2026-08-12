/**
 * Retrying the one filesystem operation Windows fails for reasons that pass.
 *
 * `rename` onto an existing path is atomic on NTFS, which is why the state file
 * is written that way — but atomic is not the same as always permitted. Windows
 * refuses the replace with `EPERM` while *any* process holds the destination
 * open, and on a git dir that is routine rather than exceptional: Defender reads
 * a file moments after it is written, the search indexer opens it, and the
 * extension and a headless run write the same file by design. None of those are
 * a permissions problem, and every one of them clears in milliseconds.
 *
 * Surfaced to the user, this failure is indistinguishable from a broken install
 * — "operation not permitted … likely caused by the extension" — and it lands on
 * the click that approves a gate, which is the moment the harness is asking for
 * trust.
 *
 * Kept pure and separate from `fs` so the policy is testable without contriving
 * a locked file.
 */

/** Errors that mean "someone else has it open", not "you may not do this". */
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

export function isTransientFsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base backoff; the delay grows linearly with the attempt number. */
  delayMs?: number;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `operation`, retrying only while it fails with a transient code.
 *
 * Deliberately re-throws anything else immediately: a genuine permissions
 * problem or a missing directory must fail on the first attempt rather than
 * after a second of silent retrying, or a real misconfiguration reads as
 * slowness.
 */
export async function retryOnTransientFsError<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 40;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      // The last attempt throws the real error, not a wrapper: the code and path
      // are what make a persistent failure diagnosable.
      if (attempt >= attempts || !isTransientFsError(error)) throw error;
      await sleep(delayMs * attempt);
    }
  }
}
