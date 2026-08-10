/**
 * A one-line version of a declined item, for the box that asks who owns it.
 *
 * The settlement prompt is a single-line input with the item as its label, and a
 * stage that wrote a paragraph turns that into five lines of prose the operator has
 * to parse before they can answer a question they already know the answer to. One
 * real item opened "the SQL and migration review stages flagged three findings" and
 * arrived at what it was actually asking two clauses later.
 *
 * Truncating is safe *because* the full text is in the stage report — this is a
 * label for a question, not the record of what was noticed. Nothing here rewrites
 * the item; `DeferralItem.text` stays the stage's own words.
 */

const DEFAULT_MAX = 110;

/**
 * The first sentence, capped. Returns the whole text when it is already short,
 * so a stage that writes one line gets its line back unchanged.
 */
export function deferralHeadline(text: string, max = DEFAULT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;

  const sentence = firstSentence(flat);
  if (sentence.length <= max) return sentence;
  return `${cutAtWord(sentence, max - 1)}…`;
}

/** Whether the headline dropped anything, so the caller can say where the rest is. */
export function isAbridged(text: string, max = DEFAULT_MAX): boolean {
  return deferralHeadline(text, max) !== text.replace(/\s+/g, " ").trim();
}

/**
 * Split on sentence-ending punctuation followed by a capital or a digit. Deliberately
 * strict about what follows: an abbreviation or a version number mid-sentence would
 * otherwise cut the item in half, and half a sentence is worse than a long one.
 */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?])\s+(?=[A-Z0-9`"'(])/.exec(text);
  return match ? match[1] : text;
}

function cutAtWord(text: string, max: number): string {
  const clipped = text.slice(0, max);
  const space = clipped.lastIndexOf(" ");
  // Only honour a word boundary that leaves most of the budget used; a very early
  // space (one long token at the front) would produce a two-word headline.
  return (space > max * 0.6 ? clipped.slice(0, space) : clipped).trimEnd();
}
