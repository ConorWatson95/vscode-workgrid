import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StateFileIo } from "./fileTaskRepository";
import { retryOnTransientFsError } from "./transientFsError";

let tempCounter = 0;

/**
 * Real filesystem adapter for the task state file. Deliberately the only place
 * that touches `fs`, so everything above it is testable with a fake.
 */
export class NodeStateFileIo implements StateFileIo {
  /**
   * Retried on the same transient codes as the write, and for a sharper reason: a
   * read that fails is not merely an error message. `undefined` here means *no state
   * file*, which is the marker for "this repository has not adopted the Memento
   * yet" — so an out-of-descriptors burst must never be allowed to look like one.
   * Hence the retry, and hence only `ENOENT` returning undefined.
   */
  async read(filePath: string): Promise<string | undefined> {
    try {
      return await retryOnTransientFsError(() => fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * Write-then-rename, because the extension and a headless run can both be
   * writing: `rename` is atomic on both NTFS and POSIX, so a concurrent reader
   * sees either the old file or the new one, never a truncated one. Writing in
   * place would expose exactly the half-written blob that quarantine exists to
   * cope with.
   *
   * The temp name carries pid and a counter so two writers cannot collide on
   * the scratch file itself.
   *
   * The rename is retried on a transient code, because on Windows an atomic
   * replace is refused outright while anything else holds the destination open —
   * Defender, the indexer, or the other writer this scheme exists to tolerate.
   * Without it the failure surfaced *after* the in-memory transition had
   * happened, so approving a gate advanced the route and then reported
   * "operation not permitted", leaving the advance unpersisted. See
   * `transientFsError.ts`.
   */
  async write(filePath: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${tempCounter++}.tmp`;
    try {
      // The scratch write is retried too: it is a fresh descriptor under exactly the
      // burst that exhausts them, and failing here loses the transition entirely.
      await retryOnTransientFsError(() => fs.writeFile(temp, contents, "utf8"));
      await retryOnTransientFsError(() => fs.rename(temp, filePath));
    } catch (error) {
      // Leaving scratch files behind would accumulate in the git dir forever.
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
