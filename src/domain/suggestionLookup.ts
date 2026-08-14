import { isNothingReported } from "./nothingReported";
import { SuggestionSource } from "./suggestionSourceFile";
import { parseSuggestions, TaskSuggestion } from "./taskSuggestion";

/**
 * Looking up **one** ref in a source, rather than listing what is outstanding.
 *
 * The gap this fills: linking a task to its ticket was reachable only from a suggestion
 * row, so only work the last scan happened to return could be linked. A scan reports what
 * is *outstanding*, which is exactly the wrong set — a task already under way is normally
 * in progress or closed on the board, so the ticket it is plainly for is the one ticket
 * that cannot be linked to it. A real task failed its UAT promotion for this: the check
 * is scoped by ticket, `${ticket}` resolved to nothing, and there was no way to supply
 * one.
 *
 * A lookup rather than a free-text field because a ref nobody verified is worse than
 * none. `${ticket}` substitutes into a promotion check that finds this task's commits
 * among everyone else's; a mistyped key matches nothing, and matching nothing is what the
 * check treats as failure — so a typo here reappears later as "your work is not on UAT".
 *
 * Same shape as a scan, deliberately: the same session runner, the same required MCP
 * servers, the same reply format and the same parser. A second transport and a second
 * reply grammar to ask a smaller question would be the runtime learning to speak JIRA,
 * which is the line held everywhere else in this feature.
 *
 * Pure and vscode-free.
 */

/** A ref the source says does not exist. Its own marker, for the reason every marker is. */
export const NOT_FOUND_MARKER = "NOT-FOUND";

export type LookupOutcome =
  | { kind: "found"; suggestion: TaskSuggestion }
  /** The source was reachable and has no such ref. */
  | { kind: "notFound" }
  /**
   * The reply neither found it nor said it was missing.
   *
   * Its own outcome rather than folded into `notFound`, because the remedies are
   * opposites: a ref that does not exist means fix the ref, and a reply nothing parsed
   * out of means the lookup did not work — and reporting the second as the first tells
   * somebody their real ticket does not exist.
   */
  | { kind: "unreadable"; reply: string };

/**
 * Asks a source about one ref.
 *
 * The source's own `scanPrompt` is included as context rather than executed: it is what
 * tells the session where this team's work lives and how to reach it, which a lookup
 * needs just as much as a scan does. What differs is the question, and it is stated after
 * the prompt so it wins on the one point they conflict — a scan prompt says "list what is
 * outstanding", and a lookup must return a ticket that is closed, in progress, or nobody's
 * priority. That is the whole reason this exists.
 */
export function buildLookupPrompt(source: SuggestionSource, ref: string): string {
  return [
    source.scanPrompt,
    "",
    "---",
    "",
    `IGNORE the instruction above about which items to list. This is a lookup, not a `,
    `scan. Use the same system and the same tools, and answer only this:`,
    "",
    `Does the item \`${ref}\` exist? Report it whatever its state — closed, in progress, `,
    "done, or assigned to somebody else. Its state is not a reason to leave it out; the " +
      "task asking about it is already being worked on.",
    "",
    "If it exists, report it on exactly these lines:",
    "",
    "SUGGESTION: <ref> | <state> | <title>",
    "URL: <link>",
    "",
    "Use the item's **own identifier** exactly as its system spells it, which may differ " +
      `in case or punctuation from \`${ref}\`. Report what the system says, not what was asked for.`,
    "",
    `If there is no such item, write \`${NOT_FOUND_MARKER}\` on a line of its own and nothing else.`,
    "",
    "Do not guess and do not construct a plausible answer. Reporting an item that does " +
      "not exist is worse than reporting nothing: it is recorded against the task and " +
      "used to scope a promotion check, which then silently matches no commits.",
    "",
    "Change nothing. This is read-only: do not comment on, assign, transition or create " +
      "anything.",
  ].join("\n");
}

/**
 * Reads a lookup reply.
 *
 * `requested` is checked against what came back, and a mismatch is **not** a find. The
 * session is asked for the system's own spelling precisely so this comparison means
 * something: a reply echoing the requested ref is the cheapest possible hallucination,
 * and one that comes back with a different key has demonstrably read a record. Compared
 * loosely — case and surrounding punctuation — because a source legitimately normalises
 * `nmgb-2534` to `NMGB-2534`, and refusing that would reject a correct answer.
 */
export function parseLookupReply(
  reply: string,
  sourceId: string,
  requested: string,
): LookupOutcome {
  if (new RegExp(`(^|\\s)${NOT_FOUND_MARKER}(\\s|$)`, "i").test(reply)) {
    return { kind: "notFound" };
  }

  const found = parseSuggestions(reply, sourceId);
  const match = found.find((entry) => refsMatch(entry.ref, requested));
  if (!match) {
    // Includes the case where something parsed but under a different ref. That is a
    // session answering about the wrong item, which must never be recorded as this one.
    return { kind: "unreadable", reply };
  }
  if (isNothingReported(match.title)) return { kind: "unreadable", reply };

  return { kind: "found", suggestion: match };
}

function refsMatch(a: string, b: string): boolean {
  return normaliseRef(a) === normaliseRef(b);
}

/** Case and non-alphanumerics dropped: `NMGB-2534`, `nmgb 2534` and `#NMGB-2534` are one ref. */
function normaliseRef(ref: string): string {
  return ref.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
