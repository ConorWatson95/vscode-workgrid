import { SuggestionSource } from "../domain/suggestionSourceFile";
import { parseSuggestions, TaskSuggestion } from "../domain/taskSuggestion";

/**
 * Runs a project's suggestion scans and holds the result.
 *
 * A scan is a **cold session with no task**, which is the whole reason this is cheap to
 * build: the runtime already knows how to start one, hand it the project's own
 * `--mcp-config`, require servers of it and parse a tolerant reply. Teaching the
 * extension to speak MCP itself would add a transport and an auth story and put the
 * reasoning back in the harness — which is the line the runtime holds everywhere else.
 *
 * **Scanning is explicit, never automatic.** A session costs money and time, and a scan
 * on every window reload would spend both on a list nobody asked for. It also means the
 * result can be held in memory rather than persisted: suggestions are derived from an
 * external source of truth, so losing them costs one command and nothing is stale for
 * longer than you can see. `scannedAt` is kept so the age is always on screen — a list
 * of work with no date on it is one you cannot tell from this morning's.
 *
 * The runner is injected as a one-method interface, so these tests need no agent.
 */

export interface SuggestionScanRunner {
  /**
   * Runs one scan prompt in a fresh session rooted at the repository, not a worktree.
   *
   * The repository, deliberately: a scan reads a ticket board, so a task's branch has
   * nothing to offer it, and running in a worktree would make what the scan can see
   * depend on which task happened to be checked out.
   */
  run(
    repositoryRoot: string,
    prompt: string,
    label: string,
    options?: { requiredMcpServers?: readonly string[]; model?: string },
  ): Promise<{ ok: boolean; text: string; error?: string }>;
}

export interface SourceScanOutcome {
  sourceId: string;
  sourceLabel: string;
  /** What the scan produced. Empty is a real answer: the board may be clear. */
  suggestions: TaskSuggestion[];
  /**
   * Why this source produced nothing, when the reason was a failure rather than an
   * empty board.
   *
   * The distinction the whole outcome type exists for. An unavailable MCP server, a
   * session that died, or a reply nothing parsed out of all yield an empty list — and
   * presented as "no work" they read as a quiet morning. A source that failed says so.
   */
  failure?: string;
}

export interface ScanResult {
  outcomes: SourceScanOutcome[];
  /** ISO timestamp of the scan, from the injected clock. */
  scannedAt: string;
}

/** All suggestions across a scan, in source order. */
export function scannedSuggestions(result: ScanResult | undefined): TaskSuggestion[] {
  return (result?.outcomes ?? []).flatMap((outcome) => outcome.suggestions);
}

/** Sources that failed, for a message the user can act on. */
export function scanFailures(result: ScanResult | undefined): string[] {
  return (result?.outcomes ?? [])
    .filter((outcome) => outcome.failure)
    .map((outcome) => `${outcome.sourceLabel}: ${outcome.failure}`);
}

export interface ServiceClockLike {
  now(): string;
}

export class SuggestionScanService {
  private latest = new Map<string, ScanResult>();

  constructor(
    private readonly runner: SuggestionScanRunner,
    private readonly clock: ServiceClockLike,
  ) {}

  /** The last scan for a repository, or undefined if none has been run. */
  lastScan(repositoryRoot: string): ScanResult | undefined {
    return this.latest.get(key(repositoryRoot));
  }

  /** Forgets a repository's scan, so a stale list cannot outlive its config. */
  forget(repositoryRoot: string): void {
    this.latest.delete(key(repositoryRoot));
  }

  /**
   * Scans every configured source and keeps the result.
   *
   * Sequential rather than concurrent. Two reasons, and the second is the load-bearing
   * one: sources share a machine and a rate limit, which is the same argument
   * `subagentLimits` makes about a stage's fan-out; and a scan is a foreground action a
   * human is waiting on, so a source that hangs should be identifiable rather than one
   * of four things happening at once.
   *
   * A source that throws is recorded as failed and the rest still run. One broken board
   * must not cost the others, exactly as one malformed route does not cost a project its
   * others.
   */
  async scan(
    repositoryRoot: string,
    sources: readonly SuggestionSource[],
  ): Promise<ScanResult> {
    const outcomes: SourceScanOutcome[] = [];

    for (const source of sources) {
      outcomes.push(await this.scanOne(repositoryRoot, source));
    }

    const result: ScanResult = { outcomes, scannedAt: this.clock.now() };
    this.latest.set(key(repositoryRoot), result);
    return result;
  }

  private async scanOne(
    repositoryRoot: string,
    source: SuggestionSource,
  ): Promise<SourceScanOutcome> {
    const base = { sourceId: source.id, sourceLabel: source.label };
    let reply: { ok: boolean; text: string; error?: string };
    try {
      reply = await this.runner.run(
        repositoryRoot,
        buildScanPrompt(source),
        `scan:${source.id}`,
        {
          ...(source.requiredMcpServers
            ? { requiredMcpServers: source.requiredMcpServers }
            : {}),
          ...(source.model ? { model: source.model } : {}),
        },
      );
    } catch (error) {
      return { ...base, suggestions: [], failure: (error as Error).message };
    }

    if (!reply.ok) {
      return {
        ...base,
        suggestions: [],
        failure: reply.error ?? "the scan session did not complete",
      };
    }

    return { ...base, suggestions: parseSuggestions(reply.text, source.id) };
  }
}

function key(repositoryRoot: string): string {
  return repositoryRoot.trim().replace(/\\/g, "/").toLowerCase();
}

/**
 * The project's own prompt, plus the reply contract.
 *
 * The split is the same one the harness draws everywhere: the *project* says where its
 * work lives and which of it counts, and the *runtime* says how to report back. A
 * project author writing a scan prompt should not have to restate a line format, and a
 * format restated per source is one that drifts until the parser stops matching it.
 *
 * The ranks are named because they are the source's own vocabulary and the runtime
 * cannot map anything onto a rank it was not told about — an unrecognised one sorts last
 * rather than being hidden, which is safe but loses the ordering the board already knew.
 */
export function buildScanPrompt(source: SuggestionSource): string {
  const lines = [
    source.scanPrompt,
    "",
    "Report each item on its own line, in this exact format:",
    "",
    "SUGGESTION: <ref> | <rank> | <state> | <title>",
    "URL: <link>",
    "DETAIL: <one line of context, optional>",
    "",
    "`ref` is the item's own identifier in its system — an issue key, not a title.",
    "Report the most important items first.",
  ];

  if (source.order.ranks.length > 0) {
    lines.push(
      "",
      `Use one of these for \`rank\`, exactly as written: ${source.order.ranks.join(", ")}. ` +
        "If an item's own priority does not match one of them, use the closest and say " +
        "so on its DETAIL line.",
    );
  }

  lines.push(
    "",
    "Report only what you actually found. If there is nothing, say so in a sentence " +
      "and write no SUGGESTION lines at all — do not write a SUGGESTION line saying " +
      '"none", because it will be read as a piece of work.',
    "",
    "Change nothing. This is a read-only scan: do not comment on, assign, transition " +
      "or create anything in any system.",
  );

  return lines.join("\n");
}
