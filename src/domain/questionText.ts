/**
 * Splitting a stage's question into the thing being asked and the background.
 *
 * The same failure `deferralText` fixes, one box along. A stage that has just spent
 * twenty minutes working something out writes the question the way it arrived at it:
 * three sentences of what it found, then the decision, then what it will do with the
 * answer. The panel rendered all of it as the question, so the operator read a
 * paragraph to answer something they already knew — and the one sentence that needed
 * an answer was usually the last.
 *
 * Nothing here rewrites the question; `PendingQuestionItem.text` stays the stage's own
 * words, and the detail is shown, not dropped. This only decides which part is the
 * prompt and which part is the reading behind it.
 *
 * Pure and vscode-free.
 */

/** A question separated into what is being asked and everything else. */
export interface SplitQuestion {
  /** The sentence to show as the prompt. */
  headline: string;
  /** The rest, in the stage's original order. Absent when there was none. */
  detail?: string;
}

/**
 * Splits on the *interrogative* sentence, not the first one.
 *
 * Which direction to prefer is the whole judgement here, and it is not the same as a
 * deferral's. A declined item leads with the work and trails into justification, so
 * its first sentence is the useful one. A question leads with justification and lands
 * on the ask, because that is the order the stage discovered it in — so taking the
 * first sentence would reliably show background and hide the question.
 */
export function splitQuestion(text: string): SplitQuestion {
  const sentences = splitSentences(text.replace(/\s+/g, " ").trim());
  if (sentences.length <= 1) return { headline: sentences[0] ?? "", detail: undefined };

  const asked = lastIndexOfQuestion(sentences);
  if (asked === -1) {
    // No question mark anywhere — an imperative like "Confirm which database to
    // target". Nothing identifies the ask, so leave the text whole rather than
    // guessing at a sentence and promoting the wrong one.
    return { headline: sentences.join(" "), detail: undefined };
  }

  const headline = sentences[asked];
  const detail = [...sentences.slice(0, asked), ...sentences.slice(asked + 1)]
    .join(" ")
    .trim();
  return { headline, detail: detail || undefined };
}

/**
 * The *last* interrogative sentence, so a question that restates itself
 * ("Should we A? That is, should we B?") ends on the sharper phrasing — which is the
 * one the stage wrote second, having noticed the first was vague.
 */
function lastIndexOfQuestion(sentences: readonly string[]): number {
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    if (sentences[index].endsWith("?")) return index;
  }
  return -1;
}

/**
 * Split on sentence-ending punctuation followed by a capital or a digit — the same
 * strictness as `deferralText`, and for the same reason: an abbreviation or a version
 * number mid-sentence would cut the question in half.
 */
function splitSentences(text: string): string[] {
  if (!text) return [];
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const match = /^(.+?[.!?])\s+(?=[A-Z0-9`"'(])/.exec(rest);
    if (!match) break;
    parts.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}
