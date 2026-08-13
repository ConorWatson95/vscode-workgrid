/**
 * Work the harness thinks you might pick up next, from wherever a project keeps its
 * work.
 *
 * The point of the feature is that starting a task is currently the one step with no
 * runtime support: you know what to work on from a ticket board or an inbox, and the
 * harness only learns about it once you have typed a name into it. So the first thing
 * it does every morning is ask you a question you have already answered somewhere else.
 *
 * **The abstraction is a ranked backlog, not an inbox to triage.** That distinction
 * decided most of what is here. An inbox needs identity, dismissal records and a
 * fingerprint to tell "I have seen this" from "this changed" — machinery that turns out
 * to be unnecessary when everything on the list has to be done eventually and the
 * source already holds stable names and its own lifecycle. What is actually wanted is
 * an ordering, and *hiding* is therefore a filter rather than a decision: reversible,
 * remembered nowhere, and impossible to lose a ticket through.
 *
 * That reasoning holds for a ticket system. It does not hold for an inbox, which has no
 * stable name and no lifecycle — so email is deliberately a *source* to be added later
 * rather than the shape this module is built around.
 *
 * **Nothing here knows what a source is.** No priority scheme, no status vocabulary,
 * no field named after a ticket system. A source supplies items with an opaque `ref`
 * and a `rank` label drawn from an order it declares, and everything JIRA-shaped stays
 * in project config — which is what makes a second source a config entry rather than a
 * release. The extension ships no sources at all, exactly as it ships no review rules:
 * which work matters is a property of a team, not of a runtime.
 *
 * Pure and vscode-free.
 */

import { isNothingReported } from "./nothingReported";

export interface TaskSuggestion {
  /** Which configured source produced it. */
  sourceId: string;
  /**
   * The source's own name for this item, opaque to the runtime.
   *
   * Identity is `sourceId` + `ref` and nothing else. Deliberately not a hash of the
   * content: two sources may legitimately describe the same underlying work, and a
   * ticket whose title was corrected is not new work.
   */
  ref: string;
  title: string;
  /** The source's rank label, e.g. a priority name. Ordered by the source's declared list. */
  rank?: string;
  /** The source's state label, when it has one. Used only for filtering. */
  state?: string;
  /** Where a human can go and read it. */
  url?: string;
  /** One or two lines of context, when the scan offered any. */
  detail?: string;
}

/** `sourceId` + `ref`, normalised, for deduplication and for matching a started task. */
export function suggestionKey(suggestion: {
  sourceId: string;
  ref: string;
}): string {
  return `${suggestion.sourceId.trim().toLowerCase()}::${suggestion.ref.trim().toLowerCase()}`;
}

/**
 * How a source's ranks order, and which of them are worth showing unprompted.
 *
 * `ranks` is the source's own vocabulary, most important first. Held as a declared list
 * rather than mapped onto numbers because a number would be the runtime taking a view
 * on what "major" means, and every board means something different by it.
 */
export interface SuggestionSourceOrder {
  ranks: readonly string[];
  /** Ranks below this one are hidden unless hidden items are being shown. */
  showFrom?: string;
  /** States that are hidden however they rank — work already finished or abandoned. */
  hideStates?: readonly string[];
}

function normalise(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/**
 * Where a rank sits in its source's order.
 *
 * An unrecognised rank sorts **last among the shown**, not first and not hidden. Two
 * failures to avoid: a typo promoting an item above genuine blockers, and a typo
 * hiding one entirely. Sorting it last costs a place in a list; hiding it loses work.
 */
export function rankIndex(order: SuggestionSourceOrder, rank: string | undefined): number {
  const wanted = normalise(rank);
  if (!wanted) return order.ranks.length;
  const found = order.ranks.findIndex((entry) => normalise(entry) === wanted);
  return found === -1 ? order.ranks.length : found;
}

/**
 * True when an item is filtered out of the default view.
 *
 * Hiding is a *view*, which is the whole reason it is safe: nothing is recorded, so
 * showing hidden items brings back everything the source still reports and no ticket
 * can be lost by being hidden once. An unrecognised rank is never hidden — see
 * `rankIndex`.
 */
export function isHidden(
  order: SuggestionSourceOrder,
  suggestion: TaskSuggestion,
): boolean {
  const state = normalise(suggestion.state);
  if (state && (order.hideStates ?? []).some((entry) => normalise(entry) === state)) {
    return true;
  }

  const floor = normalise(order.showFrom);
  if (!floor) return false;
  const floorIndex = order.ranks.findIndex((entry) => normalise(entry) === floor);
  // A `showFrom` naming a rank the source does not declare hides nothing. Silently
  // hiding the whole list on a typo is the one failure that looks exactly like the
  // source having no work in it.
  if (floorIndex === -1) return false;

  const index = rankIndex(order, suggestion.rank);
  // Unrecognised ranks (index === ranks.length) are shown, so only a rank that is
  // both recognised and below the floor is hidden.
  return index > floorIndex && index < order.ranks.length;
}

export interface RankedSuggestion extends TaskSuggestion {
  hidden: boolean;
  /** Position in its source's declared order, for display and for sorting. */
  rankIndex: number;
}

/**
 * Deduplicated and ordered, with each item marked hidden or not.
 *
 * Ordering is by rank first and by the order the source reported them second, so a
 * source that has already sorted its own output keeps that sequence within a rank —
 * a board's own ordering inside a priority is usually meaningful, and re-sorting it
 * alphabetically would discard information the runtime cannot reconstruct.
 *
 * `orderFor` is asked per source rather than passed as one order, because two sources
 * do not share a rank vocabulary and merging them into one would require exactly the
 * mapping this module refuses to invent.
 */
export function rankSuggestions(
  suggestions: readonly TaskSuggestion[],
  orderFor: (sourceId: string) => SuggestionSourceOrder | undefined,
): RankedSuggestion[] {
  const seen = new Set<string>();
  const ranked: RankedSuggestion[] = [];

  suggestions.forEach((suggestion) => {
    const key = suggestionKey(suggestion);
    // First mention wins. A re-scan or two sources reporting one ticket is one piece
    // of work, and the earlier entry is the one whose order position is meaningful.
    if (seen.has(key)) return;
    seen.add(key);

    const order = orderFor(suggestion.sourceId) ?? { ranks: [] };
    ranked.push({
      ...suggestion,
      hidden: isHidden(order, suggestion),
      rankIndex: rankIndex(order, suggestion.rank),
    });
  });

  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.rankIndex !== b.entry.rankIndex
        ? a.entry.rankIndex - b.entry.rankIndex
        : a.index - b.index,
    )
    .map(({ entry }) => entry);
}

/**
 * What to put on screen.
 *
 * `showHidden` is the toggle that makes "hide but findable" true: the filtered items
 * are one click away and always complete, because they were never recorded as
 * dismissed in the first place.
 */
export function visibleSuggestions(
  ranked: readonly RankedSuggestion[],
  showHidden: boolean,
): RankedSuggestion[] {
  return showHidden ? [...ranked] : ranked.filter((entry) => !entry.hidden);
}

/**
 * Keys for the suggestions a set of tasks was started from.
 *
 * Structural rather than typed against `TaskWorkspace`, so this module keeps knowing
 * nothing about tasks either — it is the same argument as knowing nothing about JIRA,
 * one layer in.
 */
export function startedSuggestionKeys(
  tasks: readonly { origin?: { sourceId: string; ref: string } }[],
): string[] {
  return tasks
    .map((task) => task.origin)
    .filter((origin): origin is { sourceId: string; ref: string } => !!origin)
    .map(suggestionKey);
}

/** Items already started as tasks, so the list stops offering them. */
export function withoutStarted(
  ranked: readonly RankedSuggestion[],
  startedKeys: readonly string[],
): RankedSuggestion[] {
  const started = new Set(startedKeys.map((key) => key.trim().toLowerCase()));
  return ranked.filter((entry) => !started.has(suggestionKey(entry)));
}

/**
 * A scan's reply, parsed into suggestions.
 *
 * One line per item, and tolerant for the reason every parser here is tolerant: the
 * reply comes from a model and the runtime decides what happened, never the reply.
 *
 *     SUGGESTION: NMGB-2801 | major | open | Scorecard export drops the last row
 *     URL: https://…
 *     DETAIL: Reported by two dealers this week.
 *
 * Only `ref` and a title are required; a line missing either is dropped rather than
 * guessed at, because a suggestion with no ref cannot be deduplicated or matched to a
 * task and one with no title cannot be read.
 *
 * **A scan reporting "nothing" reports nothing**, via the same guard `parseDeferrals`
 * and `parseReviewFindings` use. `SUGGESTION: none — the board is empty` is a scan
 * saying the board is clear, and taken literally it becomes a suggested task called
 * "none" that somebody can click and start.
 */
export function parseSuggestions(
  reply: string,
  sourceId: string,
): TaskSuggestion[] {
  const suggestions: TaskSuggestion[] = [];
  const lines = reply.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    const match = /^(?:[-*]\s*)?SUGGESTION\s*:\s*(.+)$/i.exec(line);
    if (match) {
      const parsed = parseSuggestionLine(match[1], sourceId);
      if (parsed) suggestions.push(parsed);
      continue;
    }

    const last = suggestions[suggestions.length - 1];
    if (!last) continue;
    // A URL or DETAIL line attaches to the item above it. Attached rather than
    // required inline because a real URL contains the same pipe-free punctuation the
    // field separator relies on, and asking for both on one line is how a scan comes
    // to write a title containing half a link.
    const url = /^(?:[-*]\s*)?URL\s*:\s*(\S+)$/i.exec(line);
    if (url && !last.url) {
      last.url = url[1];
      continue;
    }
    const detail = /^(?:[-*]\s*)?DETAIL\s*:\s*(.+)$/i.exec(line);
    if (detail && !last.detail) last.detail = detail[1].trim();
  }

  return suggestions;
}

function parseSuggestionLine(
  body: string,
  sourceId: string,
): TaskSuggestion | undefined {
  if (isNothingReported(body)) return undefined;

  const fields = body.split("|").map((field) => field.trim());
  const ref = fields[0];
  if (!ref) return undefined;

  // Title is the last field, so a source that reports fewer middles than expected
  // still yields a readable item: "REF | title" and "REF | rank | state | title" both
  // work, and the alternative — fixed positions — turns one missing field into every
  // item being mislabelled.
  const title = fields.length > 1 ? fields[fields.length - 1] : undefined;
  if (!title || isNothingReported(title)) return undefined;

  const middles = fields.slice(1, -1);
  return {
    sourceId,
    ref,
    title,
    ...(middles[0] ? { rank: middles[0] } : {}),
    ...(middles[1] ? { state: middles[1] } : {}),
  };
}
