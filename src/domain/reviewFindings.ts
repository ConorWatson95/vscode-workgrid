/**
 * Reads the findings out of a review stage's reply.
 *
 * A review reports a critical problem, a couple of important ones and some
 * suggestions — and all of it was a wall of prose that got parsed for a marker,
 * summarised as "passed", and otherwise left for someone to go and find. So the
 * one stage whose entire output is a list of things to do about the code was the
 * stage that said least on screen.
 *
 * Tolerant on purpose, and pure so the tolerance is testable. The agent is told a
 * format but writes prose, and a parser that only understood one spelling would
 * quietly report no findings — which reads as a clean review, the most dangerous
 * thing this could get wrong. When nothing matches, callers fall back to showing
 * the reply verbatim rather than claiming there was nothing to report.
 */

import { isNothingReported } from "./nothingReported";

export type FindingSeverity = "critical" | "important" | "suggestion";

export interface ReviewFinding {
  severity: FindingSeverity;
  /** The finding itself, with its severity marker and list punctuation removed. */
  text: string;
}

/** Severity order for display: worst first, which is the order they get acted on. */
export const SEVERITY_ORDER: readonly FindingSeverity[] = [
  "critical",
  "important",
  "suggestion",
];

/**
 * Words that mean each severity, including the ones agents reach for instead of
 * the ones they were asked for. `blocker` and `must fix` are critical; `nit` and
 * `consider` are suggestions.
 */
const SEVERITY_WORDS: Record<FindingSeverity, readonly string[]> = {
  critical: ["critical", "blocker", "blocking", "must fix", "must-fix", "error"],
  important: ["important", "major", "should fix", "should-fix", "warning", "concern"],
  suggestion: [
    "suggestion",
    "suggested",
    "suggest",
    "minor",
    "nit",
    "nitpick",
    "consider",
    "optional",
  ],
};

export function parseReviewFindings(reply: string | undefined): ReviewFinding[] {
  if (!reply?.trim()) return [];

  const findings: ReviewFinding[] = [];
  /** The heading a bare list item belongs under, e.g. "## Critical". */
  let heading: FindingSeverity | undefined;
  /** How many findings the current severity section has produced. */
  let inSection = 0;
  /** Unbulleted lines seen in the current section, in case it produces nothing else. */
  let plain: string[] = [];

  /**
   * Closes a severity section, falling back to its unbulleted lines if it gave
   * nothing else.
   *
   * The case this exists for cost a real review its whole verdict. A SQL review wrote
   * "Critical" as a heading and then listed three procedures on plain lines, no
   * bullets — and `listItem` accepts only a bulleted line or one carrying its own
   * severity marker, so every one was skipped and the review parsed to *nothing*. The
   * report shows the reply verbatim when nothing parses, which is deliberate, so three
   * criticals were on screen while `hasBlockingFindings` saw an empty list and the
   * route walked past them. The display and the decision disagreed, and only one of
   * them stops a route.
   *
   * Deliberately a *fallback*, not a general rule: it applies only to a section that
   * would otherwise yield nothing at all. A reviewer who bulleted anything under the
   * heading is writing prose in between, and reading each line of a wrapped paragraph
   * as its own critical is the over-count that teaches people to click past the stop.
   * So one shape or the other per section, never a mix.
   *
   * One finding per line rather than the lines joined: merging two real items is worse
   * than listing one twice, which is the same trade `deferralKey` makes.
   */
  const closeSection = () => {
    if (heading && inSection === 0) {
      for (const text of plain) {
        if (!isNothingReported(text)) {
          findings.push({
            severity: statedNonBlocking(text) ? "suggestion" : heading,
            text,
          });
        }
      }
    }
    inSection = 0;
    plain = [];
  };

  /** Whether we are inside a fenced code block. */
  let fenced = false;

  for (const rawLine of reply.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // A fenced code block is the finding's *evidence*, never findings of its own.
    //
    // The plain-line fallback below had no idea fences existed, so a section written
    // as prose — one bolded sentence per problem, each followed by the offending
    // three lines in a ```csharp block — parsed to one finding per *line of code*.
    // A real review of two problems reported seven criticals, three of them
    // statements out of the middle of a snippet and two of them the fence markers
    // themselves, which then rendered as empty code boxes because "- ```csharp"
    // opens a block that nothing closes. The count is what makes this worse than
    // ugly: `hasBlockingFindings` and the severity summary both read it.
    //
    // Skipped rather than attached to the finding above: the snippet is an argument,
    // and the full reply is shown verbatim under the findings, where there is room
    // for it. Same trade `deferralHeadline` makes.
    if (/^(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    // A heading may carry the finding with it: "### Critical: the change is against
    // the wrong stored procedure" is one line that is both the section and the
    // problem. Only a *marked* heading is read this way — a bare "CRITICAL: …" line
    // is left to the list-item path below, so that it reports itself without also
    // reclassifying every plain bullet that follows it.
    const asHeading = severityHeading(line);
    // A label with nothing after it is a section heading either way. One that
    // carries a summary is only *taken* as a heading when the line is marked as
    // one; otherwise it falls through to the list-item path below, which reports it
    // as its own finding without putting every following bullet under its severity.
    if (asHeading && (!asHeading.rest.trim() || isMarkedHeading(line))) {
      closeSection();
      heading = asHeading.severity;
      const summary = asHeading.rest.trim();
      // Same guard as the list path below: "**Important**: none" is a section
      // answered, not a problem found.
      if (summary && !isNothingReported(summary)) {
        findings.push({ severity: heading, text: summary });
        // A heading that carries its own finding has produced one, so the lines
        // underneath it are that finding's explanation rather than more findings.
        inSection += 1;
      }
      continue;
    }
    // Any other heading *clears* the severity rather than leaving it in force.
    //
    // Without this, one "Must fix before UAT promotion" section made every bullet
    // in the rest of the document critical — including a long "Other review points"
    // section whose whole purpose was to say those things were fine. A real report
    // with one blocker was counted as fourteen, which is exactly the direction that
    // matters now that findings hold the route.
    if (looksLikeHeading(line)) {
      // Inside a severity section that has produced nothing, an *unmarked* heading is
      // almost certainly a finding rather than a heading. `looksLikeHeading` is loose
      // by necessity — it has to end a section spelt `**Other review points**` or as a
      // bare short line — and "p_DescriptionCode line 171" satisfies it exactly: short,
      // no trailing full stop, no comma. So the very lines this fallback exists to
      // rescue were being read as section headings and dropped.
      //
      // Resolved in favour of keeping the content, because the two errors are not
      // equal: a heading misread as a finding is visible noise, a critical finding
      // misread as a heading is a route that does not stop. A marked heading (`##`,
      // `**bold**`) is unambiguous and still closes the section.
      if (heading && inSection === 0 && !isMarkedHeading(line)) {
        plain.push(line);
        continue;
      }
      closeSection();
      heading = undefined;
      continue;
    }

    const item = listItem(line);
    if (item === undefined) {
      // Kept rather than dropped, in case this section turns out to have no bulleted
      // items at all. Only under a severity heading: a plain line elsewhere is prose,
      // and there is no severity to give it.
      if (heading) plain.push(line);
      continue;
    }

    // An inline marker wins over the heading: a "(minor)" inside a list under
    // "Critical" is the writer correcting themselves, and taking the heading
    // would overstate it.
    const inline = inlineSeverity(item);
    const severity = inline?.severity ?? heading;
    if (!severity) continue;

    const text = (inline ? inline.rest : item).trim();
    // A section filled in with "none", or with "resolved", is the review saying it
    // has nothing outstanding at that severity. Counted, it became one important
    // finding, and an important finding holds the route — so a clean review blocked
    // itself. See `isNothingReported` for why the guard is as narrow as it is.
    if (text && !isNothingReported(text)) {
      findings.push({ severity: statedNonBlocking(text) ? "suggestion" : severity, text });
      // Counted only when the item belongs to the section: an inline "(minor)" under
      // "Critical" is its own classification, but it still means this section is
      // written as a list, which is what suppresses the plain-line fallback.
      inSection += 1;
    }
  }
  closeSection();

  return findings;
}

/**
 * Whether the finding's own text says the reviewer is not blocking on it.
 *
 * A real review under an **Important** heading, in full: "…I am not blocking on it:
 * `p_RebateCampaign_Vouchers` already reads the same two columns with the same
 * absence of an index, so this is the established access shape rather than something
 * this change introduced." The heading held the route; the sentence said not to.
 *
 * The heading is a section the reviewer chose once, at the top; this is the reviewer
 * ruling on this specific item, having done the work. It is the same principle that
 * makes a stated `VERDICT` outrank severities read out of prose — the reviewer's own
 * judgement wins over an inference about it.
 *
 * **Downgraded, not dropped.** The finding is real and worth reading; what it is not
 * is a reason to stop the route. Removing it would lose an observation the reviewer
 * thought worth writing several sentences about — "watch the execution time on the
 * first live run" is exactly the kind of thing that should survive to the report.
 *
 * Only explicit negations, so "this is blocking" is untouched.
 */
function statedNonBlocking(text: string): boolean {
  return /\b(?:not|non-?|isn'?t|aren'?t|won'?t be|do(?:es)?n'?t)\s*(?:a\s+|the\s+)?block(?:ing|er|s)?\b/i.test(
    text,
  );
}

/** "1 critical, 2 important, 4 suggestions", or undefined when there are none. */
export function summariseFindings(findings: readonly ReviewFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  return SEVERITY_ORDER.filter((severity) =>
    findings.some((finding) => finding.severity === severity),
  )
    .map((severity) => {
      const count = findings.filter((finding) => finding.severity === severity).length;
      return `${count} ${label(severity, count)}`;
    })
    .join(", ");
}

/** Whether anything found is serious enough that the work is not done. */
export function hasBlockingFindings(findings: readonly ReviewFinding[]): boolean {
  return findings.some(
    (finding) => finding.severity === "critical" || finding.severity === "important",
  );
}

/** Findings as markdown, worst first, for a report or a send-back note. */
export function formatFindings(findings: readonly ReviewFinding[]): string {
  return SEVERITY_ORDER.filter((severity) =>
    findings.some((finding) => finding.severity === severity),
  )
    .map((severity) => {
      const matching = findings.filter((finding) => finding.severity === severity);
      return [
        `**${HEADINGS[severity]}**`,
        ...matching.map((finding) => `- ${finding.text}`),
      ].join("\n");
    })
    .join("\n\n");
}

/** Fixed, so a section heading does not change shape with the count under it. */
const HEADINGS: Record<FindingSeverity, string> = {
  critical: "Critical",
  important: "Important",
  suggestion: "Suggestions",
};

function label(severity: FindingSeverity, count: number): string {
  if (severity === "suggestion") return count === 1 ? "suggestion" : "suggestions";
  // "critical" and "important" are adjectives, so they do not pluralise.
  return severity;
}

/**
 * Whether a line is a heading of any kind, severity or not.
 *
 * Tolerant because a reply's markdown does not survive intact — headings arrive as
 * `### Other review points`, as `**Other review points**`, and as a bare short
 * line. All three have to end the preceding section, or a severity heading leaks
 * over everything below it.
 *
 * A trailing full stop disqualifies a line: that is a sentence, and treating short
 * sentences as headings would clear the severity mid-list.
 */
function looksLikeHeading(line: string): boolean {
  if (/^#{1,6}\s/.test(line)) return true;
  if (listItem(line) !== undefined) return false;

  const stripped = line.replace(/[*_`]/g, "").trim();
  if (!stripped || stripped.length > 60) return false;
  if (/[.!?]$/.test(stripped)) return false;
  // A bolded line on its own, or a short colon-terminated label.
  return /^\*\*.*\*\*:?$/.test(line.trim()) || /:$/.test(stripped) || !/\s{0,}[,;]/.test(stripped);
}

/** Whether the line is explicitly marked as a heading, rather than merely looking like one. */
function isMarkedHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line.trim());
}

/**
 * A heading like "## Critical", "Critical issues:", "**Important**", and anything
 * it carries after its label.
 *
 * `rest` exists because the most natural way to write a review is one line per
 * problem with the severity in front of it — `### Critical: the change is against
 * the wrong stored procedure`. That is 55 characters, so the length cap below
 * rejected it, and the generic heading rule then cleared the severity: a real
 * blocking finding parsed to nothing at all, and the review displayed as clean.
 */
function severityHeading(
  line: string,
): { severity: FindingSeverity; rest: string } | undefined {
  const bare = line.replace(/^#{1,6}\s*/, "").replace(/[*_`]/g, "").trim();

  // Split on the label's own punctuation first, so the cap applies to the label
  // and not to the summary after it.
  const labelled = /^([a-z][a-z -]{0,38}?)\s*[:–—-]\s+(.+)$/i.exec(bare);
  if (labelled) {
    const severity = severityOf(labelled[1]);
    if (severity) return { severity, rest: labelled[2] };
  }

  const stripped = bare.replace(/[:.]+\s*$/, "").trim().toLowerCase();
  // Headings are short. Without this, a sentence merely containing "critical"
  // would reclassify every bare item after it.
  if (!stripped || stripped.length > 40) return undefined;
  // Singularised too: a heading is almost always plural ("Suggestions",
  // "Critical issues") while the marker words are singular.
  const singular = stripped.replace(/s$/, "");
  for (const severity of SEVERITY_ORDER) {
    if (
      SEVERITY_WORDS[severity].some(
        (word) =>
          stripped === word ||
          singular === word ||
          stripped.startsWith(`${word} `) ||
          singular.startsWith(`${word} `),
      )
    ) {
      return { severity, rest: "" };
    }
  }
  return undefined;
}

/**
 * The severity a short label names, whole or by any of its words.
 *
 * Shared with the inline path, because "Blocking issue" and "Minor ordering nit"
 * have to read the same whether they arrive as a heading or in a bullet.
 */
function severityOf(label: string): FindingSeverity | undefined {
  const text = label.trim().toLowerCase();
  if (!text || text.length > 40) return undefined;
  // Same guard as the inline path, and here for the same reason: a heading spelt
  // "No blocking issues: …" is a section being answered, not one being opened.
  if (negatedCount(text)) return undefined;
  for (const severity of SEVERITY_ORDER) {
    if (SEVERITY_WORDS[severity].includes(text)) return severity;
  }
  for (const word of text.split(/[\s-]+/)) {
    for (const severity of SEVERITY_ORDER) {
      if (SEVERITY_WORDS[severity].includes(word)) return severity;
    }
  }
  return undefined;
}

/** The content of a list item, or undefined when the line is not one. */
function listItem(line: string): string | undefined {
  const bullet = /^(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(line);
  if (bullet) return bullet[1];
  // A marker at the start of its own line is a finding whether or not it was
  // bulleted — "CRITICAL: the migration drops a column" needs no dash to count.
  return inlineSeverity(line) ? line : undefined;
}

/**
 * A label that reports a count of *no* findings.
 *
 * The head noun is what makes a negation safe to act on. "No blocking or deferred
 * items" is a count of nothing; "No error handling on the retry" is a finding whose
 * subject happens to start with a negative. Both carry a severity word behind a "no",
 * and only the first is the review saying the section is empty.
 */
const NEGATED_COUNT =
  /^(?:none|nothing|not any|without|zero|no)\b[a-z ,-]*?\b(?:items?|findings?|issues?|blockers?|concerns?|problems?|defects?|comments?|errors?)$/i;

/**
 * Whether a label is the review reporting *no* findings rather than marking one.
 *
 * The eighth false stop of this family, and the first to arrive through the severity
 * label rather than the finding text. A planning stage closed with
 *
 *     No blocking or deferred items — all findings from the prior review rounds were
 *     already addressed by earlier stages…
 *
 * which `inlineSeverity` read as the label "No blocking or deferred items" — 29
 * characters, all letters, containing "blocking" — and the sentence after the dash as
 * the critical finding it introduced. One critical on screen, saying in as many words
 * that there was nothing outstanding. `isNothingReported` never saw it: by then the
 * label had been stripped and what remained was a real sentence about real work.
 *
 * Deliberately keyed on the **head noun**, not on the negator. Refusing every negated
 * label would drop "No error handling — the loop swallows exceptions", which is a
 * genuine critical, and dropping a real finding is the worse error in every other rule
 * in this file.
 */
function negatedCount(label: string): boolean {
  return NEGATED_COUNT.test(label.trim());
}

/** A leading "CRITICAL:", "[minor]", "(nit)" and what follows it. */
function inlineSeverity(
  text: string,
): { severity: FindingSeverity; rest: string } | undefined {
  // Two spellings, because both turn up: a marker followed by punctuation
  // ("CRITICAL: …", "nit - …"), and a bracketed one that needs none ("(minor) …").
  const match =
    /^[[(]\s*([a-z][a-z -]*?)\s*[\])]\s*(.*)$/i.exec(text) ??
    /^[*_`\s]*([a-z][a-z -]*?)[*_`\s]*[:–—-]\s+(.*)$/i.exec(text);
  if (!match) return undefined;
  const label = match[1].trim().toLowerCase();
  // "No blocking or deferred items — …" marks nothing; it reports an empty section.
  if (negatedCount(label)) return undefined;

  // Whole label first, since that is what a bare "CRITICAL:" is.
  for (const severity of SEVERITY_ORDER) {
    if (SEVERITY_WORDS[severity].includes(label)) {
      return { severity, rest: match[2] };
    }
  }

  // Then any word of it: real reviews write "Minor ordering nit:" and "Blocking
  // issue:", not the single word the format asked for. Bounded to a short label so
  // this reads a marker, not a sentence that happens to end in a colon.
  if (label.length > 40) return undefined;
  for (const word of label.split(/[\s-]+/)) {
    for (const severity of SEVERITY_ORDER) {
      if (SEVERITY_WORDS[severity].includes(word)) {
        return { severity, rest: match[2] };
      }
    }
  }
  return undefined;
}
