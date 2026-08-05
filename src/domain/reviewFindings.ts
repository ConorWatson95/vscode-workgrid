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

  for (const rawLine of reply.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

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
      heading = asHeading.severity;
      const summary = asHeading.rest.trim();
      if (summary) findings.push({ severity: heading, text: summary });
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
      heading = undefined;
      continue;
    }

    const item = listItem(line);
    if (item === undefined) continue;

    // An inline marker wins over the heading: a "(minor)" inside a list under
    // "Critical" is the writer correcting themselves, and taking the heading
    // would overstate it.
    const inline = inlineSeverity(item);
    const severity = inline?.severity ?? heading;
    if (!severity) continue;

    const text = (inline ? inline.rest : item).trim();
    if (text) findings.push({ severity, text });
  }

  return findings;
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
