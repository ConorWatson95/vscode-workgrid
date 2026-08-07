/**
 * Whether a line is a stage answering "there is nothing outstanding here".
 *
 * Asked for by two different parsers, for the same reason and at the same cost. A
 * stage told to list what it declined, or what it found, sometimes answers the
 * question rather than omitting the section:
 *
 *     DEFERRED: none — this is Nissan GB only, so no second-manufacturer checks
 *
 *     **Important**          **Critical**
 *     - none                 - resolved
 *
 * Taken literally the first became an outstanding deferral that held a deployment,
 * and the other two became findings that blocked their reviews. Every one of them is
 * a stage reporting that everything is fine, stopping the route — the worst possible
 * direction for a false positive, because the correct response looks like the harness
 * being broken and teaches people to click past the stop that matters.
 *
 * Two vocabularies, guarded differently, because they fail differently:
 *
 * - **Absent** — "none", "n/a". The trap is the word used as a subject: "none of the
 *   migrations carry a USE statement" is a real finding. So a following preposition
 *   means it is a sentence about something, not a refusal to fill the section.
 * - **Settled** — "resolved", "fixed". The trap is the word used as an adjective:
 *   "fixed width column overflows". So the word must stand alone or run into an
 *   explanation ("fixed by widening the column"), never straight into a noun.
 *
 * Narrow on purpose in both directions. The opposite error — silently dropping a real
 * finding — is worse than a spurious hold, so anything ambiguous stays a finding.
 */

/** "There is nothing of this kind." */
const ABSENT =
  /^(none|nothing|n\/?a|not applicable|no (?:deferrals?|findings?|issues?|blockers?|concerns?))\b\s*(.*)$/is;

/** "There was something, and it is already dealt with." */
const SETTLED =
  /^(resolved|fixed|addressed|completed|closed|done|accepted|acknowledged|agreed|noted|waived|already (?:done|fixed|resolved|addressed))\b\s*(.*)$/is;

/**
 * Words that continue an explanation rather than start a subject.
 *
 * "resolved in the migration" explains; "fixed width column overflows" describes a
 * column. Only the first is the section being answered.
 */
const EXPLAINS =
  /^(?:[—–\-:;,.()[\]]|in\b|by\b|during\b|at\b|after\b|before\b|per\b|as\b|on\b|with\b|via\b|under\b|through\b|since\b|above\b|below\b|earlier\b|already\b|this\b|these\b|it\b|they\b|and\b|—)/i;

export function isNothingReported(text: string): boolean {
  const trimmed = text.trim().replace(/^[-*+•]\s+/, "");

  const absent = ABSENT.exec(trimmed);
  if (absent) {
    // "none of the migrations…", "nothing in the rollback…" — the word is the
    // subject of a real sentence, not a refusal to fill the section.
    return !/^(of|in|on|for|about|from)\b/i.test(absent[2].trim());
  }

  const settled = SETTLED.exec(trimmed);
  if (settled) {
    const rest = settled[2].trim();
    return rest.length === 0 || EXPLAINS.test(rest);
  }

  return false;
}
