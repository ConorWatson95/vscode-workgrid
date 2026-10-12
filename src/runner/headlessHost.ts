import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessSettings, recordSettingsReader } from "../configuration/harnessSettings";
import {
  SettingsFileRead,
  readSettingsFiles,
  userSettingsCandidates,
  workspaceSettingsPath,
} from "../configuration/vscodeSettingsFiles";

/**
 * What a process VS Code did not start needs to stand where the extension stands:
 * the same settings and the same machine-local storage.
 *
 * Shared by the headless runner and the MCP server, because the MCP server starts the
 * runner and has to know where its log will land — two derivations of one path are
 * how one of them ends up reading a file nobody writes.
 */

/** The extension's id as VS Code keys its storage: `<publisher>.<name>`. */
const EXTENSION_ID = "task-workspaces.task-workspaces";

export interface HeadlessSettings {
  settings: HarnessSettings;
  read: SettingsFileRead;
  /**
   * The extension's global storage folder — where VS Code keeps the process registry,
   * gate inboxes and reduced MCP configs. Shared on purpose: a stage session a crashed
   * headless runner left behind is recorded where the extension's activation sweep
   * looks, so the next window reaps it like one of its own.
   */
  storageDir: string;
}

/**
 * VS Code's settings for this repository, read from its files.
 *
 * `overrides` win over both files. A headless run forces the two interactive features
 * off — phase 1 has nobody to hold a call for or deliver an answer to mid-turn — and
 * that must not depend on what the user happens to have set.
 */
export function loadHeadlessSettings(
  repositoryRoot: string,
  overrides: Record<string, unknown> = {},
): HeadlessSettings {
  const candidates = userSettingsCandidates({
    platform: process.platform,
    home: os.homedir(),
    appData: process.env.APPDATA,
  });
  const read = readSettingsFiles(candidates, workspaceSettingsPath(repositoryRoot), readIfExists);
  const values = { ...read.values, ...overrides };
  // The storage beside whichever install's settings were read, so a runner never
  // writes into an install it took no settings from. Stable when neither exists.
  const userDir = path.dirname(candidates.find((file) => read.sources.includes(file)) ?? candidates[0]);
  return {
    settings: new HarnessSettings(recordSettingsReader(values)),
    read,
    storageDir: path.join(userDir, "globalStorage", EXTENSION_ID),
  };
}

/** The log a housekeeping tick writes, beside the per-task run logs. */
export const HOUSEKEEPING_LOG_ID = "housekeeping";

/** Where a headless run of a task writes its log. */
export function runnerLogPath(storageDir: string, taskId: string): string {
  return path.join(storageDir, "runner-logs", `${taskId}.log`);
}

/** The last lines of a log, for a launch that failed to say why. */
export function logTail(file: string, lines = 20): string | undefined {
  const text = readIfExists(file);
  if (text === undefined) return undefined;
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
