import { SuggestionSourceOrder } from "./taskSuggestion";

/**
 * Parsing and validation for a project's suggestion sources, from the `suggestions`
 * array of `.taskworkspaces/harness.json`.
 *
 * **The extension ships no sources**, exactly as it ships no review rules
 * (`NO_REVIEW_RULES`). Where a team keeps its work, which items count and what its
 * priority names mean are properties of that team, so a project that declares nothing
 * gets no suggestions and the feature is silently absent rather than guessing at a
 * board.
 *
 * A source is **config, not code**, and that is the whole abstraction: it names a scan
 * prompt, the MCP servers that prompt needs, and its own rank vocabulary. Adding Azure
 * DevOps, Linear or an inbox is therefore an edit to a project's config rather than a
 * release of the extension — which is the difference between a runtime and a JIRA
 * client.
 *
 * Pure and vscode-free; `SuggestionScanService` runs what this describes.
 */

export interface SuggestionSource {
  /** Stable; forms half of a suggestion's identity, so never renumber it. */
  id: string;
  label: string;
  /**
   * What to ask a scan session to do.
   *
   * Held as a prompt rather than a query because the runtime has no MCP client of its
   * own: a scan is a cold headless session with the project's own `--mcp-config`, which
   * reuses the session runner, the readiness check and the reply parsers already in
   * place. Teaching the extension a second transport and a second auth story would buy
   * nothing and put reasoning back in the harness.
   */
  scanPrompt: string;
  /**
   * MCP servers the scan cannot run without.
   *
   * The same declaration stages use, for a sharper version of the same reason. An agent
   * denied its ticket tooling does not stop; it substitutes a plausible guess — and a
   * *suggestion* nobody can trace back to a real ticket is worse than no suggestion,
   * because acting on it creates a task for work that may not exist. A scan whose
   * servers are unavailable is abandoned, and abandoned is reported, where an empty list
   * would read as a quiet day.
   */
  requiredMcpServers?: string[];
  /** The source's rank vocabulary and what it hides by default. */
  order: SuggestionSourceOrder;
}

export interface ParsedSuggestionSources {
  sources: SuggestionSource[];
  problems: string[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((entry): entry is string => typeof entry === "string");
  return list.length === value.length ? list.map((entry) => entry.trim()) : undefined;
}

/**
 * Reads the `suggestions` array, keeping the good entries and reporting the bad ones.
 *
 * Partial acceptance, matching `parseHarnessConfig`: one malformed source must not cost
 * a project the others, and a problem list nobody can act on is what a silent drop
 * produces.
 */
export function parseSuggestionSources(raw: unknown): ParsedSuggestionSources {
  if (raw === undefined) return { sources: [], problems: [] };
  if (!Array.isArray(raw)) {
    return {
      sources: [],
      problems: ['"suggestions" must be an array of sources.'],
    };
  }

  const sources: SuggestionSource[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const where = `Suggestion source ${index + 1}`;
    if (!entry || typeof entry !== "object") {
      problems.push(`${where}: not an object.`);
      return;
    }
    const source = entry as Record<string, unknown>;

    const id = str(source.id);
    const scanPrompt = str(source.scanPrompt);
    if (!id) {
      problems.push(`${where}: needs an "id".`);
      return;
    }
    if (!scanPrompt) {
      problems.push(`Suggestion source "${id}": needs a "scanPrompt".`);
      return;
    }
    if (seen.has(id.toLowerCase())) {
      // Kept the first, for the reason two routes sharing an id keep the first: an id
      // is half of a suggestion's identity, so two sources under one id would make
      // "already started" ambiguous.
      problems.push(`Suggestion source "${id}": duplicate id, this one is ignored.`);
      return;
    }

    const ranks = strings(source.ranks) ?? [];
    if (source.ranks !== undefined && strings(source.ranks) === undefined) {
      problems.push(`Suggestion source "${id}": "ranks" must be an array of strings.`);
      return;
    }

    const showFrom = str(source.showFrom);
    if (showFrom && !ranks.some((rank) => rank.toLowerCase() === showFrom.toLowerCase())) {
      // Rejected rather than ignored. A floor naming a rank that does not exist hides
      // nothing at all (see `isHidden`), so the source silently behaves as though the
      // setting were absent — and the author's evidence for that is a list that looks
      // longer than they asked for, which is indistinguishable from a busy board.
      problems.push(
        `Suggestion source "${id}": "showFrom" is "${showFrom}", which is not one of ` +
          `its ranks (${ranks.join(", ") || "none declared"}).`,
      );
      return;
    }

    const requiredMcpServers = strings(source.requiredMcpServers);
    if (source.requiredMcpServers !== undefined && requiredMcpServers === undefined) {
      problems.push(
        `Suggestion source "${id}": "requiredMcpServers" must be an array of server names.`,
      );
      return;
    }

    const hideStates = strings(source.hideStates);
    if (source.hideStates !== undefined && hideStates === undefined) {
      problems.push(`Suggestion source "${id}": "hideStates" must be an array of strings.`);
      return;
    }

    seen.add(id.toLowerCase());
    sources.push({
      id,
      label: str(source.label) ?? id,
      scanPrompt,
      ...(requiredMcpServers && requiredMcpServers.length > 0 ? { requiredMcpServers } : {}),
      order: {
        ranks,
        ...(showFrom ? { showFrom } : {}),
        ...(hideStates && hideStates.length > 0 ? { hideStates } : {}),
      },
    });
  });

  return { sources, problems };
}

/** The order for a source id, for `rankSuggestions`. */
export function orderLookup(
  sources: readonly SuggestionSource[],
): (sourceId: string) => SuggestionSourceOrder | undefined {
  const byId = new Map(sources.map((source) => [source.id.toLowerCase(), source.order]));
  return (sourceId: string) => byId.get(sourceId.trim().toLowerCase());
}
