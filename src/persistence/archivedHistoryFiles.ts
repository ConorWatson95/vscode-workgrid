import * as fs from "node:fs";
import * as path from "node:path";
import { ArchivedSession } from "../agents/sessionArchive";

export interface ArchivedTaskHistory {
  taskId: string;
  name: string;
  branchName: string;
  archivedAt: string;
  sessions: ArchivedSession[];
}

/**
 * The record of a removed task's archived transcripts, kept beside the transcripts
 * themselves (`<archive>/<taskId>/archived.json`).
 *
 * The index used to live only in VS Code's global state, which a removal from Claude
 * cannot write: the transcripts were copied and then listed nowhere. A file in the
 * archive directory is reachable from both, and is what VS Code merges into its list.
 */
export const ARCHIVED_HISTORY_FILE = "archived.json";

export function writeArchivedHistory(baseDir: string, entry: ArchivedTaskHistory): void {
  const dir = path.join(baseDir, entry.taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ARCHIVED_HISTORY_FILE), JSON.stringify(entry, null, 2), "utf8");
}

/** Every record under `baseDir`. An unreadable one is skipped rather than failing the list. */
export function readArchivedHistories(baseDir: string): ArchivedTaskHistory[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(baseDir);
  } catch {
    return [];
  }
  const found: ArchivedTaskHistory[] = [];
  for (const dir of dirs) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(baseDir, dir, ARCHIVED_HISTORY_FILE), "utf8"));
      if (entry && typeof entry.taskId === "string" && Array.isArray(entry.sessions)) found.push(entry);
    } catch {
      /* no record, or not one we can read */
    }
  }
  return found;
}
