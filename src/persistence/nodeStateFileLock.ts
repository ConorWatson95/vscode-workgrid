import * as fs from "node:fs/promises";
import * as path from "node:path";
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

      const contents = await this.readLock();
      const record = contents === undefined ? undefined : parseLockRecord(contents);
      const modifiedAt = contents !== undefined && !record ? await this.modifiedAt() : undefined;
      // Two cases are never broken, because the `rm` below removes whatever is at the
      // path *now*, which may be a lock another process has taken since. Gone between
      // the create and the read means released — the next create is the handover. And
      // an unreadable lock whose age cannot be read either is one this process cannot
      // judge: on Windows that is a lock deleted while somebody else was reading it,
      // still pending, and breaking it raced a fresh holder's create. Waiting costs at
      // most the give-up window.
      const judgeable = contents !== undefined && (record !== undefined || modifiedAt !== undefined);
      if (
        judgeable &&
        isBreakable(record, {
          now: this.now(),
          owner: this.owner,
          policy: this.policy,
          modifiedAt,
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
    const create = () =>
      fs.writeFile(this.lockPath, JSON.stringify({ owner: this.owner, at: this.now() }), {
        flag: "wx",
      });
    try {
      await create();
      return true;
    } catch (error) {
      // The state directory does not exist until the first write creates it, so the
      // first write to a repository waited out the whole give-up window and then wrote
      // unlocked. Creating it here is the same directory that write would create.
      if ((error as { code?: unknown }).code === "ENOENT") {
        try {
          await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
          await create();
          return true;
        } catch {
          return false;
        }
      }
      // Every failure means the same thing to the caller: the lock was not taken.
      // EEXIST is the ordinary case; a permission or directory error is not
      // recoverable by waiting, and the give-up path handles it.
      return false;
    }
  }

  /**
   * The lock file's contents; undefined only when it does not exist. Any other read
   * failure is reported as unreadable (`""`), so it is judged by age like a
   * half-written record rather than mistaken for a released lock and never broken.
   */
  private async readLock(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.lockPath, "utf8");
    } catch (error) {
      return (error as { code?: unknown }).code === "ENOENT" ? undefined : "";
    }
  }

  private async modifiedAt(): Promise<string | undefined> {
    try {
      return (await fs.stat(this.lockPath)).mtime.toISOString();
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
