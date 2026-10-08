/**
 * Feedback arriving on a ticket while its task waits on others.
 *
 * `checklistAudience: "others"` moves a task out of `Needs you` because the next move is
 * somebody else's — and the rule that justified it also named the cost: testers do not
 * notify the tree. The age on the row keeps a fortnight-old wait from looking fresh, but
 * it cannot say that the tester has *answered*. A comment saying "the export is still
 * wrong" sat on the ticket while the task stayed filed as delegated, which is the
 * forgotten task that grouping was warned about, arriving by the other door.
 *
 * So a source may declare a `feedbackCommand`, polled for tasks under `Waiting on
 * others`, and any comment newer than both the start of the wait and the operator's
 * last "read" files the task as theirs again.
 *
 * Three rules:
 *
 * - **A command, never a session.** The project owns the transport and its credentials,
 *   exactly as it owns the scan prompt; the runtime learns no ticket system. And a
 *   session per poll is ~$0.40, which turns a background check into a bill.
 * - **Whose comment it is, is the command's to decide.** Filtering out the operator's own
 *   comments needs an identity only the ticket system holds, so the project's script
 *   drops them. A comment that slips through costs one glance, the cheap direction.
 * - **Derived against the wait, never cleared by hand.** A recorded comment older than
 *   the current gate's wait is simply not new — so a gate approved and a later one
 *   reached needs no reset, and nothing can leave a task stuck in `Needs you` for a
 *   conversation that belonged to the previous gate.
 *
 * Pure and vscode-free.
 */

export interface FeedbackComment {
  author: string;
  /** ISO 8601, as the source reported it. */
  at: string;
  /** The opening of the comment, for the row's tooltip. */
  excerpt: string;
}

/** What the last poll found, persisted on the task. */
export interface ExternalFeedback {
  /** Newest comment reported since the wait began; absent when there was none. */
  latest?: FeedbackComment;
  /** How many comments the last poll reported since the wait began. */
  count: number;
  checkedAt: string;
  /**
   * When the operator said they had read it and the task is still with others.
   * Comments at or before this do not count.
   */
  readAt?: string;
}

export const MAX_EXCERPT_CHARS = 200;

/**
 * Parses what a feedback command printed.
 *
 * Accepts `{"comments":[...]}` or a bare array. Entries missing a parseable date are
 * dropped rather than failing the whole reply — one malformed comment must not hide the
 * rest — but a reply that is not JSON at all is an error, because reading it as "no
 * comments" would report a broken script as a quiet ticket.
 */
export function parseFeedbackOutput(
  stdout: string,
): { ok: true; comments: FeedbackComment[] } | { ok: false; reason: string } {
  const text = stdout.trim();
  // Tolerate a script that logs a line or two before its JSON.
  const start = text.search(/[[{]/);
  if (start < 0) return { ok: false, reason: "printed no JSON" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch (error) {
    return { ok: false, reason: `printed unreadable JSON (${(error as Error).message})` };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { comments?: unknown })?.comments)
      ? (parsed as { comments: unknown[] }).comments
      : undefined;
  if (!list) return { ok: false, reason: 'printed JSON with no "comments" array' };

  const comments: FeedbackComment[] = [];
  for (const entry of list) {
    const raw = entry as { author?: unknown; created?: unknown; at?: unknown; body?: unknown };
    const at = typeof raw.created === "string" ? raw.created : raw.at;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
    const body = typeof raw.body === "string" ? raw.body.replace(/\s+/g, " ").trim() : "";
    comments.push({
      author: typeof raw.author === "string" && raw.author.trim() ? raw.author.trim() : "someone",
      at,
      excerpt:
        body.length > MAX_EXCERPT_CHARS ? `${body.slice(0, MAX_EXCERPT_CHARS - 1)}…` : body,
    });
  }
  return { ok: true, comments };
}

/** The moment after which a comment counts as new: the later of the wait and the read. */
export function feedbackCutoff(
  waitSince: string,
  readAt: string | undefined,
): string {
  if (!readAt) return waitSince;
  return Date.parse(readAt) > Date.parse(waitSince) ? readAt : waitSince;
}

/** Condenses a poll's comments into what is persisted. */
export function summariseFeedback(
  comments: FeedbackComment[],
  cutoff: string,
  checkedAt: string,
  readAt: string | undefined,
): ExternalFeedback {
  const after = Date.parse(cutoff);
  const fresh = comments
    .filter((comment) => Date.parse(comment.at) > after)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    ...(fresh[0] ? { latest: fresh[0] } : {}),
    count: fresh.length,
    checkedAt,
    ...(readAt ? { readAt } : {}),
  };
}

/**
 * Whether a waiting task has feedback the operator has not seen.
 *
 * `waitSince` absent means no external wait is in play, so there is nothing for
 * feedback to interrupt and the answer is no — the rule the row's age already follows.
 */
export function hasUnreadFeedback(
  feedback: ExternalFeedback | undefined,
  waitSince: string | undefined,
): boolean {
  const latest = feedback?.latest;
  if (!latest || !waitSince) return false;
  const at = Date.parse(latest.at);
  if (Number.isNaN(at)) return false;
  return at > Date.parse(feedbackCutoff(waitSince, feedback.readAt));
}

/**
 * The command to run, or why it cannot be.
 *
 * The ref is checked against a conservative shape before it reaches a shell: it came
 * from a verified lookup, but a value substituted into a command line is not the place
 * to find out it did not.
 */
export function feedbackCommandFor(
  template: string,
  ref: string,
  since: string,
): { ok: true; command: string } | { ok: false; reason: string } {
  if (!/^[A-Za-z0-9._#-]+$/.test(ref)) {
    return { ok: false, reason: `ref "${ref}" has characters unsafe on a command line` };
  }
  if (Number.isNaN(Date.parse(since)) || !/^[0-9T:.Z+-]+$/.test(since)) {
    return { ok: false, reason: `"${since}" is not a timestamp` };
  }
  return {
    ok: true,
    command: template.split("${ref}").join(ref).split("${since}").join(since),
  };
}
