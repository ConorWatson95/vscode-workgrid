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

/**
 * One behaviour the CLI attributes usage to, e.g. 53% "at >150k context".
 *
 * These are independent characteristics, not a partition — the CLI says so
 * explicitly, and they routinely sum well past 100%. A single request can be
 * long-context *and* subagent-heavy *and* in a parallel session.
 */
export interface UsageFactor {
  label: string;
  percent: number;
}

/** A ranked list, e.g. "Top skills: /foo 6%, /bar 2%". */
export interface UsageTopList {
  /** e.g. "skills", "subagents", "plugins", "MCP servers". */
  kind: string;
  entries: { name: string; percent: number }[];
}

/** A reporting window from the contributing-factors section. */
export interface UsagePeriod {
  /** e.g. "Last 24h". */
  label: string;
  requests?: number;
  sessions?: number;
  factors: UsageFactor[];
  lists: UsageTopList[];
}

export interface PlanUsage {
  lines: UsageLine[];
  /** What the CLI attributes the usage to, per reporting window. */
  periods: UsagePeriod[];
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

/** `Last 24h · 1240 requests · 16 sessions` */
const PERIOD_RE = /^Last\s+(\S+)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions\s*$/i;
/** `53% of your usage was at >150k context` */
const FACTOR_RE = /^(\d{1,3})%\s+of your usage\s+(.+?)\s*$/i;
/** `Top skills: /foo 6%, /bar 2%` */
const TOP_RE = /^Top\s+([^:]{1,40}):\s*(.+?)\s*$/i;

/**
 * Shortens a factor description for display. The CLI writes full sentences
 * ("53% of your usage was at >150k context"); the percentage is rendered
 * separately, so only the distinguishing part is wanted.
 */
export function tidyFactorLabel(text: string): string {
  return text.replace(/^(was while|came from|was in|was at|was|while|from|in|at)\s+/i, "").trim();
}

/**
 * Parses the "What's contributing to your limits usage?" section into one entry
 * per reporting window. Unrecognised lines are skipped rather than guessed at,
 * so a wording change degrades to showing less instead of showing nonsense.
 */
export function parseContributors(text: string): UsagePeriod[] {
  const periods: UsagePeriod[] = [];
  let current: UsagePeriod | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const period = PERIOD_RE.exec(line);
    if (period) {
      current = {
        label: `Last ${period[1]}`,
        requests: Number(period[2].replace(/,/g, "")),
        sessions: Number(period[3].replace(/,/g, "")),
        factors: [],
        lists: [],
      };
      periods.push(current);
      continue;
    }
    if (!current) continue; // preamble, before any window

    const factor = FACTOR_RE.exec(line);
    if (factor) {
      const percent = Number(factor[1]);
      const label = tidyFactorLabel(factor[2]);
      if (percent >= 0 && percent <= 100 && label) current.factors.push({ label, percent });
      continue;
    }

    const top = TOP_RE.exec(line);
    if (top) {
      const entries: { name: string; percent: number }[] = [];
      for (const part of top[2].split(",")) {
        // Each entry ends with its share: "general-purpose 4%".
        const entry = /^(.+?)\s+(\d{1,3})%$/.exec(part.trim());
        if (!entry) continue;
        const percent = Number(entry[2]);
        if (percent >= 0 && percent <= 100) entries.push({ name: entry[1].trim(), percent });
      }
      if (entries.length > 0) current.lists.push({ kind: top[1].trim(), entries });
    }
  }
  return periods;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Turns the CLI's reset text (`Jul 30, 2pm (Europe/London)`) into epoch ms.
 *
 * The clock is read as local time and the timezone suffix ignored: the CLI
 * prints the machine's own zone, so they already agree. No year is given, so
 * the one that lands nearest `now` wins — that keeps a December→January reset
 * from reading as eleven months in the past.
 *
 * Returns undefined for anything unrecognised, so callers fall back to the
 * literal text rather than showing an invented time.
 */
export function parseResetAt(text: string, now: number = Date.now()): number | undefined {
  const m = /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return undefined;

  const day = Number(m[2]);
  const minute = m[4] ? Number(m[4]) : 0;
  const meridiem = m[5]?.toLowerCase();
  let hour = Number(m[3]);
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;

  const year = new Date(now).getFullYear();
  let best: number | undefined;
  for (const y of [year - 1, year, year + 1]) {
    const candidate = new Date(y, month, day, hour, minute).getTime();
    if (isNaN(candidate)) continue;
    if (best === undefined || Math.abs(candidate - now) < Math.abs(best - now)) best = candidate;
  }
  return best;
}

/**
 * Formats a reset time the way the Claude extension does — `2 days`, `7 hrs`,
 * `45 mins` — rather than an absolute timestamp.
 */
export function formatResetIn(atMs: number, now: number = Date.now()): string {
  const ms = atMs - now;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"}`;
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
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
        const text = assistantTextOf(stdout);
        const lines = parseUsageOutput(text);
        if (lines.length === 0) {
          logger.debug("/usage probe returned no parseable lines.");
          resolve(undefined);
          return;
        }
        resolve({ lines, periods: parseContributors(text), fetchedAt: Date.now() });
      },
    );
  });
}
