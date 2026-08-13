/**
 * Condensing a stage's intent to the line another stage needs to see.
 *
 * Every stage is told the whole route, because a stage blind to it raises work the
 * next stage already owns — that is what gives `DEFERRED` its meaning. But the route
 * was delivered as every stage's *full* intent, and an intent is written to execute a
 * stage, not to identify it: on `report-change` the twenty-two intents total 23,000
 * characters, so each session carried roughly 4,400 tokens of operating instructions
 * for stages it would never run, and a route run spent about 97,000 tokens describing
 * itself to itself.
 *
 * A reader of the list is answering one question — does some other stage cover the
 * thing I am about to raise? — and that needs what a stage *covers*, not how to do it.
 * The opening sentences answer it: intents here lead with the objective and follow
 * with method, which is exactly the split wanted.
 *
 * Deliberately not a model call. Summarising twenty-two intents per stage would cost
 * more than the text it saves, and the result has to be byte-identical across every
 * stage of a task or the cached prefix breaks — see `preamble`.
 */

/** Cap on a single stage's summary. Roughly two lines; past that it is an intent again. */
export const MAX_SUMMARY_CHARS = 200;

/**
 * Below this, one sentence is too thin to identify a stage on its own ("Investigate
 * before writing code."), so the next one is pulled in while it still fits.
 */
const MIN_SUMMARY_CHARS = 60;

/** Sentence end followed by the start of another. Kept loose; over-splitting only costs detail. */
const SENTENCE_BOUNDARY = /(?<=[.?!])\s+(?=[A-Z(])/;

/**
 * The first sentence or two of an intent, flattened to one line and capped.
 *
 * An intent shorter than the cap is returned as-is: it is already a summary, and
 * paraphrasing it would only lose detail.
 */
export function summariseIntent(intent: string): string {
  const flat = intent.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_SUMMARY_CHARS) return flat;

  let summary = "";
  for (const sentence of flat.split(SENTENCE_BOUNDARY)) {
    const next = summary ? `${summary} ${sentence}` : sentence;
    if (summary && (summary.length >= MIN_SUMMARY_CHARS || next.length > MAX_SUMMARY_CHARS)) {
      break;
    }
    summary = next;
  }

  return summary.length > MAX_SUMMARY_CHARS ? truncateOnWord(summary) : summary;
}

/**
 * Trim to the cap at a word boundary. A summary cut mid-word reads as text that was
 * lost rather than text that was shortened, which invites the reader to go looking
 * for the rest — and there is nowhere to look, the full intent is not in this prompt.
 */
function truncateOnWord(text: string): string {
  const clipped = text.slice(0, MAX_SUMMARY_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).replace(/[.,;:]$/, "")}…`;
}
