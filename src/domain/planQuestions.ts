/**
 * A plan that says it is not finished, in prose nobody reads.
 *
 * Measured on NMGB-2814, 26 Aug 2026. `rc-plan` did everything its intent asked
 * and more: it read the ticket over MCP, downloaded the attachments, wrote its own
 * xlsx parser because none was available, pulled the pyramid box labels out of
 * `xl/drawings/drawing3.xml` by regex, read four mock-up screenshots, and produced
 * a 429-line plan naming the report it was matching. It then closed with a
 * `## Open questions / risks` heading carrying **11 items**, and said in its own
 * report:
 *
 * > *they need a human answer before stage 3/4 proceed*
 * > *A human should resolve the open questions list before stage 3 starts, since
 * > several change what SQL gets built.*
 *
 * The stage settled `passed`. Eleven minutes later `rc-implement-sql` started, and
 * every one of those questions was answered by a guess. Eighteen corrections and
 * amendments followed.
 *
 * This is the twelfth instance of the disease the rest of this domain is built
 * against — a reply claiming an outcome no parser checks — after `DEFERRED`,
 * `BLOCKED`, `ACTION`, the plan step, `CORRECTION-DECLINED`, `changedNothing`,
 * `correctionChangedNothing` and the never-opened pull request. It is the most
 * expensive of them, because the others stop one stage and this one poisons every
 * stage behind it: a provisional plan is read by each later session as settled
 * fact, and subtask-per-session means each guesses the same gap independently.
 *
 * ## Why this is looser than `parseReviewFindings`, deliberately
 *
 * Every other check in this domain is written narrow, because a false stop teaches
 * the operator to click past the stop that matters. The cost here is different in
 * kind. A planning stage is followed by an approval gate the operator is standing
 * at anyway with the plan open — so a false positive costs one click on a document
 * they were about to read, where a missed question costs a stage per guess. That
 * asymmetry is what licenses matching an inline phrase and not only a heading.
 *
 * It is still guarded against the one case that would fire constantly: a plan with
 * an open-questions heading and nothing under it, or "none", is settled. That is
 * `isNothingReported`'s fourth caller.
 *
 * ## Why the document and not the reply
 *
 * Step identity comes from the file for `planSteps` because the plan is written by
 * one cold session and executed by another. The same reasoning applies harder
 * here: the reply is discarded once parsed, while the document is what the next
 * eight stages actually read. A question that survives in the reply and not the
 * plan has already been lost.
 *
 * Pure and vscode-free.
 */

import { isNothingReported } from "./nothingReported";

/** An unresolved question a plan document is carrying. */
export interface PlanQuestion {
  /** The question as written, trimmed of its bullet or number. */
  text: string;
  /** 1-based line in the plan document, so the operator can go straight to it. */
  line: number;
}

/**
 * Headings that introduce a list of things the plan could not settle.
 *
 * Matched on the heading's own words rather than on question marks anywhere in the
 * document, because a plan legitimately uses a rhetorical question as structure
 * ("Which report does this match? — the Aftersales dashboard") and holding on that
 * would fire on well-written plans.
 */
const QUESTION_HEADING =
  /^\s{0,3}#{1,6}\s*.*\b(open\s+questions?|unresolved|unanswered|to\s+confirm|needs?\s+(?:a\s+)?(?:human\s+)?(?:answer|decision)|questions?\s*(?:\/|,|&|and)?\s*risks?|risks?\s*(?:\/|,|&|and)\s*(?:open\s+)?questions?|assumptions?\s+to\s+confirm|open\s+items?|awaiting\s+(?:a\s+)?(?:decision|answer))\b/i;

/** Any heading at all, so a question section ends where the next section starts. */
const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;

/** A bulleted or numbered line, which is how a listed question is written. */
const LIST_ITEM = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;

/**
 * A phrase a plan uses to flag a question inline, mid-step, rather than under a
 * heading.
 *
 * The pyramid plan did this three times — "Flag as an open question (does it apply
 * to just IMT Pen box 10, the whole Trade side…)" — inside numbered implementation
 * steps, where a heading-only parser sees nothing. Kept to phrases that can only
 * mean an unsettled decision: "question for sign off" and "flag as an open
 * question" have no innocent reading, where a bare "unclear" or "TBC" appears in
 * plans describing what the *existing* code does unclearly.
 */
const INLINE_QUESTION =
  /\b(?:flag(?:ged)?\s+as\s+an?\s+open\s+question|open\s+question\s*[:(]|question\s+for\s+sign[\s-]?off|needs?\s+(?:a\s+)?human\s+(?:answer|decision)|must\s+be\s+answered\s+before)\b/i;

/**
 * A listed item that is itself a statement that there are none.
 *
 * `isNothingReported` reads an absent word as a *subject* ("none of the migrations
 * carry a USE statement") and so does not catch "No open questions" — where the
 * negation governs the head noun. That is the `NEGATED_COUNT` case, and it is
 * guarded here rather than by widening `isNothingReported`, which `parseDeferrals`
 * and `parseReviewFindings` also depend on: a change there to settle a plan would
 * change what stops a deployment.
 *
 * Keyed on the head noun, never on the negator alone — refusing every negated line
 * would drop "No decision yet on the colour scheme", which is exactly a question.
 */
const NO_QUESTIONS =
  /^\s*(?:no|none|zero|nil)\b[^.]{0,40}?\b(?:open\s+)?(?:questions?|items?|risks?|unknowns?|blockers?|gaps?)\b/i;

/** Longest question kept, so a hold reason stays readable in a notification. */
const MAX_QUESTIONS = 12;

/**
 * A whole item that is only a statement that everything is answered.
 *
 * `isNothingReported` catches a bare "resolved" — a settled word standing alone —
 * but not "All resolved", where the quantifier makes it a sentence. Anchored to
 * the whole item and length-capped for the reason `startsLikeSentence` exists: a
 * prefix test would swallow "All resolved except the colour scheme", which is a
 * question wearing a settlement's opening words.
 */
const ALL_ANSWERED =
  /^(?:all|everything|these)\s+(?:are\s+|have\s+been\s+|were\s+)?(?:resolved|answered|settled|closed|confirmed|addressed|agreed)\.?$/i;

/** True when a line says there is nothing outstanding, however it is spelled. */
function settled(text: string): boolean {
  return NO_QUESTIONS.test(text) || ALL_ANSWERED.test(text) || isNothingReported(text);
}

/**
 * Finds the questions a plan document is still carrying.
 *
 * Two passes, and both are needed: the heading pass catches the tidy case that
 * cost this task eighteen corrections, and the inline pass catches a plan that
 * raises a decision inside the step it belongs to — which is better writing and
 * would otherwise be invisible.
 *
 * Deduplicated by line, so an inline phrase inside a listed item under the heading
 * is one question rather than two.
 */
export function parsePlanQuestions(document: string): PlanQuestion[] {
  const lines = document.split(/\r?\n/);
  const found = new Map<number, string>();

  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];

    if (ANY_HEADING.test(raw)) {
      // A heading always closes the previous section, so a question list cannot
      // run on into "## Next steps" and claim every line after it.
      inSection = QUESTION_HEADING.test(raw);
      continue;
    }

    const item = LIST_ITEM.exec(raw);
    if (inSection && item) {
      const text = item[1].trim();
      if (text && !settled(text)) found.set(index + 1, text);
      continue;
    }

    if (INLINE_QUESTION.test(raw)) {
      const text = (item ? item[1] : raw).trim();
      if (text && !settled(text)) found.set(index + 1, text);
    }
  }

  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_QUESTIONS)
    .map(([line, text]) => ({ line, text }));
}

/**
 * The reason recorded when a plan is held.
 *
 * Names the file and the count rather than restating the questions: the operator
 * is about to open the plan, and the one thing they need from the hold is *where*.
 * Truncation is safe here for the reason `deferralHeadline`'s is — the full text is
 * in the document, which is the thing being pointed at.
 */
export function planQuestionsReason(planFile: string, questions: readonly PlanQuestion[]): string {
  const lines = questions.map((question) => `line ${question.line}`).join(", ");
  return (
    `${planFile} still carries ${questions.length} unresolved question(s) (${lines}). ` +
    "Holding rather than passing: the stages after this one are fresh sessions that " +
    "read the plan as settled fact, so an unanswered question there is answered by a " +
    "guess in each of them. Answer them in the plan, then approve — or re-run the " +
    "stage, which will ask you directly."
  );
}
