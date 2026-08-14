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
  /**
   * Model for this source's scan, overriding the extension-wide default.
   *
   * Worth having per source for the same reason a stage has one: a scan is "call a tool
   * and format a list", which is the cheapest kind of work in the runtime, and paying
   * the default model for it is most of what a scan costs. Measured against a real
   * board, the reasoning was 1,411 output tokens against a 148k-token prefix — so the
   * model tier, not the prompt, is the lever.
   */
  model?: string;
  /**
   * What one of this source's refs looks like, as a regular expression.
   *
   * Here rather than in the domain because a `ref` is opaque to the runtime — the same
   * rule that keeps priority names, states and queries in config. The built-in shape is
   * JIRA's (`PROJECT-123`), which is fine as a default and wrong as an assumption: a
   * source keyed on numbers, GUIDs or `#1234` has refs the runtime would refuse to
   * accept for a ticket that plainly exists.
   *
   * Matched against the **whole** ref, so a pattern need not anchor itself. Only used
   * to check what a human typed before a lookup is paid for; the source itself is still
   * the authority on whether the ref exists.
   */
  refPattern?: string;
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

    const refPattern = str(source.refPattern);
    if (refPattern) {
      try {
        new RegExp(refPattern);
      } catch (error) {
        // Rejected rather than ignored, for the reason `showFrom` is: a pattern that
        // does not compile would fall back to the built-in shape, so the source appears
        // to work while refusing every ref that is not JIRA-shaped — and the author's
        // evidence is a rejection of a ticket they can see on their own board.
        problems.push(
          `Suggestion source "${id}": "refPattern" is not a valid regular expression ` +
            `(${(error as Error).message}).`,
        );
        return;
      }
    }

    seen.add(id.toLowerCase());
    sources.push({
      id,
      label: str(source.label) ?? id,
      scanPrompt,
      ...(refPattern ? { refPattern } : {}),
      // Blank rather than absent leaves the default in place, matching how a route stage
      // treats a blank model: passing an empty --model is worse than passing none.
      ...(str(source.model) ? { model: str(source.model) as string } : {}),
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
