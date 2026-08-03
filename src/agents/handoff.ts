/**
 * Checkpoint-and-clear: an alternative to `/compact`.
 *
 * `/compact` summarises a conversation *in place* and keeps going in the same
 * session, so the context only ever grows back and the operation itself is slow.
 * A checkpoint instead asks the agent for a written handoff, persists it, then
 * starts a **fresh** session briefed from that handoff. The carried-forward state
 * becomes a bounded, inspectable artifact rather than an ever-growing transcript.
 *
 * The size cap is the point. A brief that grows with the work reproduces the
 * problem one level up, so `formatHandoffBrief` truncates by section with an
 * explicit marker — losing detail visibly beats losing it silently.
 *
 * vscode-free and process-free, so all of it is unit-tested.
 */

export interface Handoff {
  /** One-paragraph statement of where the work stands. */
  summary: string;
  /** Completed work, most significant first. */
  done: string[];
  /** Work still outstanding. */
  remaining: string[];
  /** Decisions and constraints a fresh session could not re-derive. */
  decisions: string[];
  /** Files touched so far, so the next session need not rediscover them. */
  filesTouched: string[];
  /** The single next action. */
  nextStep?: string;
}

/**
 * The prompt that asks for a handoff. Phrased around what a *fresh* session
 * cannot re-derive: the code is still on disk and re-readable, so the valuable
 * content is decisions and intent, not a description of the diff.
 */
export const HANDOFF_PROMPT = `Write a handoff for a fresh session that will continue this work with no memory of this conversation.

Use exactly these headings, and keep it under 400 words total:

## Summary
Where the work stands, in one short paragraph.

## Done
## Remaining
## Decisions
## Files
## Next step

Rules:
- Under "Decisions", record only what a new session could NOT work out by reading the code: rejected approaches and why, constraints you were given, assumptions you made.
- Do not describe the diff. The code is on disk and will be re-read.
- Do not restate the original request.
- Under "Files", list paths only, one per line.
- Be specific. "Fixed the mapping" is useless; name what changed and why.`;

/** Headings recognised in a handoff reply, mapped to their field. */
const SECTIONS: ReadonlyArray<[RegExp, keyof Handoff]> = [
  [/^#{1,4}\s*summary\b/i, "summary"],
  [/^#{1,4}\s*(?:done|completed)\b/i, "done"],
  [/^#{1,4}\s*(?:remaining|outstanding|to\s*do)\b/i, "remaining"],
  [/^#{1,4}\s*(?:decisions?|constraints?)\b/i, "decisions"],
  [/^#{1,4}\s*(?:files?|paths?)\b/i, "filesTouched"],
  [/^#{1,4}\s*next\s*step/i, "nextStep"],
];

export interface ParsedHandoff {
  handoff: Handoff;
  /**
   * False when no recognised headings were found. The raw text is then used as
   * the summary — a shapeless handoff is still far better than none, and
   * discarding it would lose the only record of the session.
   */
  structured: boolean;
}

/** Tolerantly parses a handoff reply. Never throws; never returns nothing. */
export function parseHandoff(text: string): ParsedHandoff {
  const handoff: Handoff = {
    summary: "",
    done: [],
    remaining: [],
    decisions: [],
    filesTouched: [],
  };

  const lines = text.split(/\r?\n/);
  let current: keyof Handoff | undefined;
  const prose: Record<string, string[]> = { summary: [], nextStep: [] };
  let structured = false;

  for (const line of lines) {
    const heading = SECTIONS.find(([pattern]) => pattern.test(line.trim()));
    if (heading) {
      current = heading[1];
      structured = true;
      continue;
    }
    if (!current) continue;

    const content = line.trim();
    if (content.length === 0) continue;

    if (current === "summary" || current === "nextStep") {
      prose[current].push(content);
      continue;
    }
    const item = stripBullet(content);
    if (item) (handoff[current] as string[]).push(item);
  }

  handoff.summary = prose.summary.join(" ").trim();
  const nextStep = prose.nextStep.join(" ").trim();
  if (nextStep) handoff.nextStep = nextStep;

  if (!structured) {
    // Unstructured reply: keep it whole rather than dropping it.
    return { handoff: { ...handoff, summary: text.trim() }, structured: false };
  }
  return { handoff, structured: true };
}

/**
 * Removes list markers. Applied repeatedly because models often emit doubled
 * markers ("- 2. item"), which would otherwise leave stray numbering in the
 * carried-forward brief.
 */
function stripBullet(line: string): string {
  let result = line.trim();
  for (let pass = 0; pass < 2; pass++) {
    const stripped = result.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "").trim();
    if (stripped === result) break;
    result = stripped;
  }
  return result;
}

export interface BriefOptions {
  /**
   * Hard cap on the brief's length. The default keeps a resumed session's
   * opening context to roughly a page — small enough that the next checkpoint
   * starts from near-zero rather than from the last brief.
   */
  maxChars?: number;
  /** Task name, so a fresh session knows what it is working on. */
  taskName?: string;
  /** Optional outstanding verification items to carry over. */
  outstandingChecklist?: readonly string[];
}

const DEFAULT_MAX_CHARS = 4000;

/**
 * Builds the opening message for a fresh session.
 *
 * Sections are emitted in priority order and truncation happens from the end, so
 * the most load-bearing content (what to do next, and the decisions that cannot
 * be re-derived) survives a squeeze while the file list is what gets cut.
 */
export function formatHandoffBrief(
  handoff: Handoff,
  options: BriefOptions = {},
): string {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  const header = options.taskName
    ? `Continuing work on "${options.taskName}". You have no memory of the previous session; this is the handoff.`
    : "You have no memory of the previous session; this is the handoff.";

  const sections: string[] = [];
  if (handoff.summary) sections.push(`## Summary\n${handoff.summary}`);
  if (handoff.nextStep) sections.push(`## Next step\n${handoff.nextStep}`);
  if (handoff.remaining.length) {
    sections.push(`## Remaining\n${bullets(handoff.remaining)}`);
  }
  if (handoff.decisions.length) {
    sections.push(`## Decisions and constraints\n${bullets(handoff.decisions)}`);
  }
  if (options.outstandingChecklist?.length) {
    sections.push(
      `## Outstanding verification\n${bullets([...options.outstandingChecklist])}`,
    );
  }
  if (handoff.done.length) sections.push(`## Already done\n${bullets(handoff.done)}`);
  if (handoff.filesTouched.length) {
    sections.push(`## Files touched\n${bullets(handoff.filesTouched)}`);
  }

  const parts = [header, ...sections];
  let brief = parts.join("\n\n");
  if (brief.length <= max) return brief;

  // Drop whole trailing sections rather than cutting mid-sentence; only fall
  // back to a hard cut if even the header plus first section is too long.
  const kept = [header];
  for (const section of sections) {
    const candidate = [...kept, section].join("\n\n");
    if (candidate.length + TRUNCATION_NOTE.length > max) break;
    kept.push(section);
  }
  brief = [...kept, TRUNCATION_NOTE].join("\n\n");
  return brief.length <= max ? brief : brief.slice(0, max);
}

const TRUNCATION_NOTE =
  "_(Handoff truncated to keep the resumed context small. Re-read the code for detail.)_";

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** True when a handoff carries nothing worth resuming from. */
export function isEmptyHandoff(handoff: Handoff): boolean {
  return (
    handoff.summary.trim().length === 0 &&
    handoff.done.length === 0 &&
    handoff.remaining.length === 0 &&
    handoff.decisions.length === 0 &&
    !handoff.nextStep
  );
}
