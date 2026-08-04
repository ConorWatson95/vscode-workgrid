import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StateFileIo } from "./fileTaskRepository";

let tempCounter = 0;

/**
 * Real filesystem adapter for the task state file. Deliberately the only place
 * that touches `fs`, so everything above it is testable with a fake.
 */
export class NodeStateFileIo implements StateFileIo {
  async read(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, "utf8");
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
   */
  async write(filePath: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${tempCounter++}.tmp`;
    try {
      await fs.writeFile(temp, contents, "utf8");
      await fs.rename(temp, filePath);
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
