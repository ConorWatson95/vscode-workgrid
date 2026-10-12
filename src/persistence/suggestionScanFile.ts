import * as path from "node:path";
import type { ScanResult, SourceScanOutcome } from "../services/suggestionScanService";
import { StateFileIo } from "./fileTaskRepository";

/**
 * The last suggestion scan, on disk beside the task state file.
 *
 * Held in memory until a second client existed, and that was honest then: a scan was
 * a command in one window, so the list was exactly as old as the last time that window
 * asked. Claude's pane starts a fresh server process for every call, so a scan it
 * started had nowhere to land, and a scan VS Code ran was invisible to it. One file
 * under the git common dir is what both read — the same reason `state.json` lives there.
 *
 * A file of its own, never a field in `state.json`: a scan is derived from an external
 * source of truth and replaced wholesale, while the state file is the only copy of the
 * tasks and is merged with care. Losing this file costs one scan.
 */

export const SUGGESTION_SCAN_FILE_NAME = "suggestions.json";

export interface ScanInProgress {
  startedAt: string;
  /** The process doing the scan, so a reader can tell a running scan from a dead one. */
  pid: number;
}

export interface StoredScan {
  /** Absent until a scan has finished. */
  scan?: ScanResult;
  /** Set while a scan runs; a pid that is no longer alive means it died mid-scan. */
  scanning?: ScanInProgress;
}

export function suggestionScanFilePath(stateDirectory: string): string {
  return path.join(stateDirectory, SUGGESTION_SCAN_FILE_NAME);
}

/**
 * Tolerant: anything unreadable is no scan at all. Nothing here is the only copy of
 * anything, so quarantine would be ceremony — the remedy is the next scan.
 */
export function decodeSuggestionScanFile(text: string | undefined): StoredScan {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const stored: StoredScan = {};

  const scan = record.scan as Record<string, unknown> | undefined;
  if (scan && typeof scan.scannedAt === "string" && Array.isArray(scan.outcomes)) {
    const outcomes = (scan.outcomes as unknown[]).filter(isOutcome);
    stored.scan = { scannedAt: scan.scannedAt, outcomes };
  }
  const scanning = record.scanning as Record<string, unknown> | undefined;
  if (scanning && typeof scanning.startedAt === "string" && typeof scanning.pid === "number") {
    stored.scanning = { startedAt: scanning.startedAt, pid: scanning.pid };
  }
  return stored;
}

export function encodeSuggestionScanFile(stored: StoredScan): string {
  return `${JSON.stringify({ version: 1, ...stored }, null, 2)}\n`;
}

function isOutcome(value: unknown): value is SourceScanOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  return (
    typeof outcome.sourceId === "string" &&
    typeof outcome.sourceLabel === "string" &&
    Array.isArray(outcome.suggestions) &&
    (outcome.suggestions as unknown[]).every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).ref === "string" &&
        typeof (item as Record<string, unknown>).title === "string",
    )
  );
}

/**
 * Reads and writes the scan file for whichever repository is asked about.
 *
 * The directory is resolved per call because it comes from `git --git-common-dir`,
 * which is async and which the caller already knows how to answer.
 */
export class SuggestionScanFileStore {
  constructor(
    private readonly io: StateFileIo,
    private readonly stateDirectoryFor: (repositoryRoot: string) => Promise<string | undefined>,
  ) {}

  async read(repositoryRoot: string): Promise<StoredScan> {
    const directory = await this.stateDirectoryFor(repositoryRoot);
    if (!directory) return {};
    return decodeSuggestionScanFile(await this.io.read(suggestionScanFilePath(directory)));
  }

  async write(repositoryRoot: string, stored: StoredScan): Promise<void> {
    const directory = await this.stateDirectoryFor(repositoryRoot);
    if (!directory) return;
    await this.io.write(suggestionScanFilePath(directory), encodeSuggestionScanFile(stored));
  }
}

/**
 * Whether a recorded scan is still running. A marker whose process has gone is a scan
 * that died, and treating it as running would refuse every scan after it forever.
 */
export function scanStillRunning(
  stored: StoredScan,
  alive: (pid: number) => boolean,
): ScanInProgress | undefined {
  return stored.scanning && alive(stored.scanning.pid) ? stored.scanning : undefined;
}
