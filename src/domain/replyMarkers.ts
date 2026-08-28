/**
 * How a marker is recognised in a reply, shared by every parser that reads one.
 *
 * Lives in the domain because the reply contract is the harness's, not one engine
 * adapter's: `planSteps` reads `STEP <n>` and `stagePrompts` reads the other six, and
 * a lead-in that differed between them would be two contracts wearing one name.
 */

/**
 * What may sit between the start of a line and a marker.
 *
 * Every marker is anchored to a line start so the word in prose — "the migration is
 * blocked on UAT" — is not read as protocol. The anchor was `[ \t]*`, which is the
 * whole of what a reply is allowed to put in front of one, and a reply is markdown:
 * a stage asked for a line beginning `BLOCKED:` wrote `### BLOCKED: the load could
 * not be run on UAT`, because it was writing a section of a report and that is what
 * a section looks like. The marker was rejected, the stage settled `passed`, and the
 * route carried on to a gate that asked a human to confirm the very thing the stage
 * had just said in writing it could not do.
 *
 * So the lead-in admits what markdown puts before a line's first word — heading
 * hashes, block quotes, an opening bold run — and nothing else. It stays strict about
 * the part that does the work: the marker still owns the start of its own line, so
 * prose cannot reach it, and none of these can appear mid-sentence.
 */
const MARKER_LEAD = "[ \\t]*(?:>[ \\t]*)*(?:#{1,6}[ \\t]+)?(?:\\*\\*|__)?";

/** The closing half of a bold run, when the marker itself was emphasised. */
const MARKER_CLOSE = "(?:\\*\\*|__)?";

/**
 * A marker's line, with `text` capturing the rest of it.
 *
 * Built rather than written out at each site so a seventh marker cannot be added
 * with a stricter anchor than the six — which is how this defect would recur, one
 * marker at a time.
 */
export function markerLine(marker: string, tail = "[ \\t]*(.+)$"): string {
  return `^${MARKER_LEAD}${marker}${MARKER_CLOSE}${tail}`;
}

/**
 * A captured marker text, with the closing half of an emphasised marker removed.
 *
 * `**BLOCKED: no FTPControl**` closes its bold run after the reason rather than after
 * the colon, so the asterisks land inside the capture and would otherwise be persisted
 * as part of the reason and shown to a human that way.
 *
 * Conditional on the line having *opened* a bold run, which is the whole care needed
 * here: a reason may legitimately end in asterisks — the first real reply this was run
 * against ended `***REDACTED***`, and stripping unconditionally ate two of the three.
 * A marker is protocol and the reason is the operator's only account of what stopped
 * the route, so the tie breaks towards leaving the text exactly as written.
 */
export function markerText(captured: string | undefined, line?: string): string {
  const text = (captured ?? "").trim();
  const opened = line !== undefined && /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+)?(?:\*\*|__)/.test(line);
  return (opened ? text.replace(/(?:\*\*|__)\s*$/, "").trim() : text);
}
