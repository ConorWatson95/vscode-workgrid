/**
 * Policy for the state file's cross-process lock, kept apart from the filesystem
 * so every rule here is testable without one.
 *
 * The lock exists because `FileTaskRepository`'s mutation queue serialises one
 * extension host and nothing else. Two processes — a window and a headless run,
 * or two windows on different worktrees of the same repository — share the file
 * through the git common dir, and their read-modify-write cycles interleave the
 * same way two concurrent saves did inside one host.
 *
 * The governing rule is **fail open**. A lock that cannot be taken must never
 * stop a write: an unwritable transition is the failure this whole area exists
 * to prevent, and a stuck lock file would reproduce it permanently and for every
 * task at once, which is strictly worse than the race it guards. So every path
 * here ends in "go ahead anyway", and the only question is how long to wait first
 * and when to conclude the holder is gone.
 */

/** What a lock file contains. Enough to judge it stale, and nothing else. */
export interface LockRecord {
  /**
   * Who holds it. Identifies the *lock instance*, not the process.
   *
   * Keyed on the process alone, two locks on one file inside one host each read
   * the other's hold as their own and break it on sight — so they serialised
   * against every other process and not against each other. The extension makes
   * one lock per repository today, but "one instance per file per process" is an
   * assumption nothing enforces, and the failure is silent.
   */
  owner: string;
  /** ISO time it was taken. */
  at: string;
}

export interface LockPolicy {
  /**
   * Beyond this age a lock is assumed abandoned and may be broken.
   *
   * Generous relative to a write, which is milliseconds: the cost of breaking a
   * live lock is the lost update it exists to prevent, and the cost of waiting is
   * a pause nobody sees. Ten seconds is far longer than any honest hold and far
   * shorter than a person notices.
   */
  staleAfterMs: number;
  /** Total time to wait before giving up and writing unlocked. */
  giveUpAfterMs: number;
  /** Pause between attempts. */
  retryEveryMs: number;
}

export const DEFAULT_LOCK_POLICY: LockPolicy = {
  staleAfterMs: 10_000,
  giveUpAfterMs: 2_000,
  retryEveryMs: 25,
};

/**
 * Parses a lock file's contents.
 *
 * Unreadable is deliberately **not** an error: a half-written lock file is
 * exactly what a process killed mid-acquire leaves, and treating it as a valid
 * hold would wedge the file until someone deleted it by hand. Undefined means
 * "no usable holder", which callers read as breakable.
 */
export function parseLockRecord(contents: string | undefined): LockRecord | undefined {
  if (contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { owner, at } = parsed as { owner?: unknown; at?: unknown };
  if (typeof owner !== "string" || owner.length === 0) return undefined;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return undefined;
  return { owner, at };
}

/**
 * Whether an existing lock may be broken.
 *
 * Three ways in, and the first two matter more than the age:
 *
 * - **Unreadable** — see `parseLockRecord`. No holder can be identified, so there
 *   is nobody to wait for.
 * - **Ours** — a lock this *instance* left behind cannot be waited on, because the
 *   thing that would release it is the caller. Only reachable if a release failed;
 *   waiting would be a guaranteed deadlock against ourselves.
 * - **Older than `staleAfterMs`** — the holder died. A killed process leaves no
 *   trace but its lock file, which is precisely today's failure one level down.
 */
export function isBreakable(
  record: LockRecord | undefined,
  options: { now: string; owner: string; policy: LockPolicy },
): boolean {
  if (!record) return true;
  if (record.owner === options.owner) return true;
  const age = Date.parse(options.now) - Date.parse(record.at);
  // A lock stamped in the future is a clock difference between two machines
  // sharing a checkout, not a fresh hold — and treating it as fresh would wait
  // out the whole give-up window on every write.
  if (!Number.isFinite(age)) return true;
  return age >= options.policy.staleAfterMs || age < 0;
}

/** The path a lock takes beside the file it guards. */
export function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}
