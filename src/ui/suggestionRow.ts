import { RankedSuggestion } from "../domain/taskSuggestion";

/**
 * How a suggestion reads in the tree.
 *
 * Pure, so the wording is tested. It matters more than it looks: this list is read to
 * decide what to work on, and a row that leads with a ticket key rather than what the
 * work *is* makes the list a lookup table you have to cross-reference.
 */

export interface SuggestionRowVisual {
  label: string;
  description: string;
  tooltip: string;
  iconId: string;
  /** True for a row only visible because hidden items are being shown. */
  dimmed: boolean;
}

export function suggestionRow(suggestion: RankedSuggestion): SuggestionRowVisual {
  const description = [
    suggestion.ref,
    // The rank is worth showing because the ordering is the whole product, and an
    // unranked item sitting at the bottom otherwise looks arbitrary.
    suggestion.rank,
    suggestion.state,
  ]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(" · ");

  const tooltip = [
    `**${suggestion.title}**`,
    "",
    `${suggestion.ref}${suggestion.rank ? ` · ${suggestion.rank}` : ""}` +
      `${suggestion.state ? ` · ${suggestion.state}` : ""}`,
    ...(suggestion.detail ? ["", suggestion.detail] : []),
    ...(suggestion.url ? ["", suggestion.url] : []),
    ...(suggestion.hidden
      ? [
          "",
          "_Below this source's `showFrom` rank, so it is filtered out of the default" +
            " view. Nothing is recorded — it reappears whenever hidden items are shown._",
        ]
      : []),
  ].join("\n");

  return {
    // Title first: the row is read to decide what to work on, and the key is the
    // lookup, not the decision.
    label: suggestion.title,
    description,
    tooltip,
    iconId: suggestion.hidden ? "circle-outline" : "lightbulb",
    dimmed: suggestion.hidden,
  };
}

/**
 * The group heading, which has to carry the age of the list.
 *
 * A scan is explicit, so the list is exactly as old as the last time you asked — and a
 * list of work with no date on it is one you cannot tell from this morning's. Says
 * "never scanned" rather than showing nothing, because an empty group and an unscanned
 * one are opposite facts: one means there is no work, the other that nobody has looked.
 */
export function suggestionGroupDescription(
  count: number,
  scannedAt: string | undefined,
  now: number,
  failures: number,
): string {
  if (!scannedAt) return "not scanned";

  const parts = [`${count}`];
  const age = Date.parse(scannedAt);
  parts.push(Number.isNaN(age) ? "scanned" : `scanned ${formatAge(now - age)}`);
  // Named on the heading, not only in a notification: a scan that failed for one source
  // shows a short list, and a short list is indistinguishable from a quiet board.
  if (failures > 0) {
    parts.push(failures === 1 ? "1 source failed" : `${failures} sources failed`);
  }
  return parts.join(" · ");
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
