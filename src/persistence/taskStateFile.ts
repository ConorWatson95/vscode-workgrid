import * as path from "node:path";
import { TaskWorkspace } from "../domain/taskWorkspace";
import {
  CURRENT_SCHEMA_VERSION,
  MigrationOutcome,
  StoredState,
  migrateStoredState,
} from "./storedStateMigration";

/**
 * The on-disk shape of task state, and where it lives.
 *
 * Kept free of `fs` so the encode/decode rules are unit-testable: the only
 * thing the filesystem adapter does is move bytes.
 *
 * State lives under the repository's common git directory rather than in the
 * working tree. That is not cosmetic — the rules engine keys reviews off git's
 * changed paths, so a state file inside a worktree could oblige a review by
 * being written. Under the git dir it is invisible to `git status`, shared by
 * every linked worktree, and never committed.
 */

/** Directory under the git common dir that holds everything the harness owns. */
export const STATE_DIR_NAME = "task-workspaces";
const STATE_FILE_NAME = "state.json";
/** Where an unreadable file is parked, so a bad blob is recoverable by hand. */
const QUARANTINE_FILE_NAME = "state.quarantine.json";

export function taskStateDir(gitCommonDir: string): string {
  return path.join(gitCommonDir, STATE_DIR_NAME);
}

export function taskStateFilePath(gitCommonDir: string): string {
  return path.join(taskStateDir(gitCommonDir), STATE_FILE_NAME);
}

export function taskStateQuarantinePath(gitCommonDir: string): string {
  return path.join(taskStateDir(gitCommonDir), QUARANTINE_FILE_NAME);
}

/**
 * Reads file contents into usable tasks. `undefined` means the file is absent,
 * which is an empty store rather than an error — a repo that has never run the
 * harness is not a corrupt one.
 *
 * Unparseable text is quarantined verbatim, never discarded: tasks hold the
 * only copy of a worktree's friendly metadata, so dropping the blob would turn
 * a user's task list into a list of unadopted orphans.
 */
export function decodeTaskStateFile(text: string | undefined): MigrationOutcome {
  if (text === undefined) {
    return { tasks: [], quarantined: [], fromNewerVersion: false, notes: [] };
  }

  // An empty or whitespace-only file is how an interrupted write can leave
  // things. There is nothing to recover, so treat it as absent rather than
  // parking a blank blob for inspection.
  if (text.trim().length === 0) {
    return {
      tasks: [],
      quarantined: [],
      fromNewerVersion: false,
      notes: ["Task state file was empty; treating it as no tasks."],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      tasks: [],
      // The raw text, not the parsed value — that is all there is to keep.
      quarantined: [text],
      fromNewerVersion: false,
      notes: [
        `Task state file was not valid JSON (${
          error instanceof Error ? error.message : String(error)
        }); quarantining it.`,
      ],
    };
  }

  return migrateStoredState(raw);
}

export function encodeTaskStateFile(tasks: TaskWorkspace[]): string {
  const state: StoredState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    tasks,
  };
  // Pretty-printed: this file is meant to be readable when something has gone
  // wrong, and it is small. Trailing newline so it behaves in a terminal.
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function encodeQuarantine(entries: unknown[], at: string): string {
  return `${JSON.stringify({ quarantinedAt: at, entries }, null, 2)}\n`;
}
