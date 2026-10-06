/**
 * Items a check could never settle, kept off the list a check settles.
 *
 * `retireChecklistItem` shipped the day before this and answered the wrong half of the
 * question. It gave the operator a way to withdraw an item nothing can answer — which
 * is a disposition, applied by hand, per item, on every task, forever. The operator's
 * own words are what settle it: *"if they're not answerable, they shouldn't be
 * checklist items"*. Not withdrawn afterwards. Not written.
 *
 * The distinction the checklist actually trades in is narrower than "answerable". A
 * checklist item is a claim that **a specific verification was performed**, and a tick
 * is the evidence. Two things cannot produce one:
 *
 * - A **judgement** — *"the figures are right for this dealer"*. There is no exit code
 *   and there is no baseline; a person decides, forever, and the decision is the
 *   approval itself rather than a tick beside it.
 * - A **race or a timing claim** — proved on the Pyramid export task rather than
 *   argued. Two flow checks were written for a Period/From race and **both passed
 *   against the broken commit**, so a tick there means *"I did not happen to reproduce
 *   it"*, which is the one kind of tick that makes every other tick on the list worth
 *   less.
 *
 * Both still reach the operator — they are recorded on the stage and rendered in its
 * report under their own heading, where the gate's approval is the moment they are
 * read. What they no longer do is sit unchecked on a list whose only admissible
 * answers were to assert a verification nobody performed or to leave the route stopped.
 *
 * **A capability gap is not one of these**, and conflating them is the failure this
 * must not cause. A gap is an item a check *could* answer that nobody has written yet;
 * it stays an item, stays outstanding, and is counted by `summariseCoverage` precisely
 * so the number goes down when the suite grows. Moving a gap here would make the
 * coverage figure improvable by relabelling, which is the one way it can lie — the
 * argument `retired` is already kept separate for.
 */

/**
 * Splits a trailing `[judgement]` or `[judgement: why]` tag off an item's text.
 *
 * Trailing and bracketed, because that is where `splitCheckTag` already reads from and
 * an item legitimately carries a leading scope tag at the other end. Matched on the
 * literal word, so an item ending in any other bracketed aside keeps it: a review
 * writing `… (Excel only)` is describing the item, and quietly removing that would
 * change what a person is being asked to do.
 *
 * The reason is kept where it is given. A judgement with no reason is still a
 * judgement — the tag is the claim and the reason is courtesy — but an operator
 * reading *"the figures are right for this dealer"* months later wants the sentence
 * saying why nothing could check it.
 */
export function splitJudgementTag(text: string): { text: string; judgement?: string } {
  const match = /^(.*?)\s*[[(]\s*judge?ments?\s*(?:[:=]\s*([^\])]{0,200}?))?\s*[\])]\s*$/is.exec(
    text,
  );
  if (!match) return { text: text.trim() };

  const rest = match[1].trim();
  // A bullet that was nothing but the tag claims nothing and asks for nothing. Left as
  // written rather than dropped here, so the caller's own empty-text guard decides —
  // the rule `splitCheckTag` and `splitScopeTag` both follow.
  if (!rest) return { text: text.trim() };
  return { text: rest, judgement: (match[2] ?? "").trim() || undefined };
}

/**
 * How a judgement reads on the stage report, as one line.
 *
 * The reason is appended rather than replacing the claim: the claim is what a person
 * has to form a view about, and the reason only says why no check will form it for
 * them.
 */
export function formatJudgement(entry: JudgementItem): string {
  return entry.why ? `${entry.text} — ${entry.why}` : entry.text;
}

/** A claim recorded for a person to read, never to tick. */
export interface JudgementItem {
  text: string;
  /** Why no check can settle it, where the stage said. */
  why?: string;
}
