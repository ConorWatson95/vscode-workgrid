import * as fs from "node:fs";
import { Logger } from "../logging/logger";

export interface StateFileWatch {
  dispose(): void;
}

/**
 * Calls `onChange` when the task state file is replaced by anybody — this window, a
 * headless run, or the harness MCP server Claude starts.
 *
 * Until a second client existed nothing needed this: every write came from this host,
 * and each call site refreshed the tree itself. A decision made in Claude reached the
 * file and nothing else, so the tree went on showing a gate as awaiting approval that
 * had already passed — the stale copy every other write here is careful not to act on.
 *
 * Watches the **directory**, not the file. Writes are an atomic rename
 * (`nodeStateFileIo.ts`), which replaces the file's inode, and a watch on the file
 * itself follows the old one and goes silent after the first write. Events are
 * filtered to the state file's name so the lock file and the temp file beside it do
 * not trigger a render each, and debounced because one rename is several events on
 * Windows.
 *
 * Own writes are not suppressed: they refresh a tree the call site has usually just
 * refreshed, and the tree's own throttle absorbs the duplicate. Telling them apart
 * would mean the repository announcing its writes, which is more coupling than a
 * redundant render is worth.
 *
 * Non-fatal: a directory that cannot be watched leaves the window exactly as it was
 * before this existed, logged rather than thrown, since activation must not fail over
 * a refresh.
 */
export function watchStateFile(
  directory: string,
  fileName: string,
  onChange: () => void,
  logger: Logger,
  debounceMs = 250,
): StateFileWatch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true });
    watcher = fs.watch(directory, (_event, changed) => {
      // `changed` can be null on some platforms; then any event counts.
      if (changed !== null && changed.toString() !== fileName) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onChange();
      }, debounceMs);
    });
    watcher.on("error", (error) => logger.warn(`State file watch stopped: ${error}`));
  } catch (error) {
    logger.warn(`Could not watch ${directory} for task state changes: ${error}`);
  }
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
