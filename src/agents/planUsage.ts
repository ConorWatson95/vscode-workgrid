import { execFile } from "node:child_process";
import { Logger } from "../logging/logger";
import { parseStreamLine } from "./streamJson";

/** One reported limit window, e.g. "Current week (all models): 27% used". */
export interface UsageLine {
  /** e.g. "Current session", "Current week (all models)". */
  label: string;
  percent: number;
  /** Human-readable reset time as the CLI prints it, if given. */
  resets?: string;
}

export interface PlanUsage {
  lines: UsageLine[];
  /** When this snapshot was taken (epoch ms). */
  fetchedAt: number;
}

/**
 * Matches the CLI's `/usage` lines:
 *   `Current week (all models): 27% used · resets Jul 30, 2pm (Europe/London)`
 * The reset clause is optional — per-model lines omit it.
 */
const USAGE_LINE = /^(.{1,80}?):\s*(\d{1,3})%\s*used\s*(?:[·|-]\s*resets\s+(.+?))?\s*$/;

/**
 * Extracts usage percentages from `/usage` output text.
 *
 * This parses human-readable output because the CLI exposes no machine-readable
 * usage command, so it is deliberately tolerant: unrecognised lines are skipped
 * rather than treated as errors, and an empty result means "couldn't read it"
 * so callers can fall back instead of showing something wrong.
 */
export function parseUsageOutput(text: string): UsageLine[] {
  const lines: UsageLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = USAGE_LINE.exec(raw.trim());
    if (!m) continue;
    const percent = Number(m[2]);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    lines.push({ label: m[1].trim(), percent, resets: m[3]?.trim() });
  }
  return lines;
}

/** Pulls the assistant text out of a stream-json transcript. */
export function assistantTextOf(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseStreamLine(line);
    if (!event || event.type !== "assistant") continue;
    const content = event.message?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Runs `/usage` in a throwaway session and returns the parsed percentages.
 *
 * Deliberately a separate session, never the user's chat, so it doesn't appear
 * in their transcript. `/usage` is answered locally by the CLI (the reply comes
 * back as a `<synthetic>` model with zero input and output tokens), so this
 * costs no tokens — only the process spawn.
 *
 * Resolves to undefined on any failure; usage display must never be load-bearing.
 */
export function fetchPlanUsage(
  command: string,
  cwd: string,
  logger: Logger,
): Promise<PlanUsage | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", "/usage"],
      { cwd, windowsHide: true, timeout: 60_000, shell: process.platform === "win32", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          logger.debug(`/usage probe failed: ${error.message}`);
          resolve(undefined);
          return;
        }
        const lines = parseUsageOutput(assistantTextOf(stdout));
        if (lines.length === 0) {
          logger.debug("/usage probe returned no parseable lines.");
          resolve(undefined);
          return;
        }
        resolve({ lines, fetchedAt: Date.now() });
      },
    );
  });
}
