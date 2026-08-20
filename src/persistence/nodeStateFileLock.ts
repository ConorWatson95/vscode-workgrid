import * as fs from "node:fs/promises";
import {
  DEFAULT_LOCK_POLICY,
  LockPolicy,
  isBreakable,
  lockPathFor,
  parseLockRecord,
} from "./stateFileLock";

/**
 * A mutual exclusion primitive around one file. Injected, so the repository's
 * rules stay testable without a filesystem and a caller that supplies none
 * behaves exactly as it did before locking existed.
 */
export interface StateFileLock {
  /**
   * Runs `operation` with the lock held where it could be taken, and without it
   * where it could not. Never rejects on the lock's own account — see the
   * fail-open rule in `stateFileLock.ts`.
   */
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

/** Narrow log sink, matching the rest of persistence. */
interface LockLogSink {
  info(message: string): void;
}

/**
 * Filesystem lock for the task state file, so two *processes* cannot interleave
 * a read-modify-write. Within one process the repository's own queue does it.
 *
 * `wx` is the whole mechanism: an exclusive create is atomic on NTFS and POSIX
 * alike, so whoever creates the file holds the lock. Everything else here is
 * about not being wedged by a holder that died.
 */
/** Distinguishes two lock instances in one process; see `LockRecord.owner`. */
let instances = 0;

export class NodeStateFileLock implements StateFileLock {
  private readonly lockPath: string;
  private readonly owner = `${process.pid}-${instances++}`;

  constructor(
    filePath: string,
    private readonly logger?: LockLogSink,
    private readonly policy: LockPolicy = DEFAULT_LOCK_POLICY,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.lockPath = lockPathFor(filePath);
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const held = await this.acquire();
    try {
      return await operation();
    } finally {
      if (held) await this.release();
    }
  }

  /** True when the lock is held, false when the caller should proceed without it. */
  private async acquire(): Promise<boolean> {
    const deadline = Date.parse(this.now()) + this.policy.giveUpAfterMs;

    for (;;) {
      if (await this.tryCreate()) return true;

      const record = parseLockRecord(await this.readLock());
      if (
        isBreakable(record, {
          now: this.now(),
          owner: this.owner,
          policy: this.policy,
        })
      ) {
        // Removed rather than overwritten: overwriting leaves the holder — if
        // there is one — believing it still holds the lock, where an unlink makes
        // its own release a no-op and the next create the real handover.
        await fs.rm(this.lockPath, { force: true }).catch(() => undefined);
        if (await this.tryCreate()) return true;
      }

      if (Date.parse(this.now()) >= deadline) {
        // Announced, because writing unlocked is the condition the lock exists to
        // avoid and a silent fallback is indistinguishable from the lock working.
        this.logger?.info(
          `Task state: could not take the lock within ${this.policy.giveUpAfterMs}ms; ` +
            "writing without it rather than dropping the change.",
        );
        return false;
      }

      await delay(this.policy.retryEveryMs);
    }
  }

  private async tryCreate(): Promise<boolean> {
    try {
      await fs.writeFile(
        this.lockPath,
        JSON.stringify({ owner: this.owner, at: this.now() }),
        { flag: "wx" },
      );
      return true;
    } catch {
      // Every failure means the same thing to the caller: the lock was not taken.
      // EEXIST is the ordinary case; a permission or directory error is not
      // recoverable by waiting, and the give-up path handles it.
      return false;
    }
  }

  private async readLock(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.lockPath, "utf8");
    } catch {
      return undefined;
    }
  }

  private async release(): Promise<void> {
    // A failed release must not fail the write that already succeeded: the lock
    // ages out, which is what `staleAfterMs` is for.
    await fs.rm(this.lockPath, { force: true }).catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
