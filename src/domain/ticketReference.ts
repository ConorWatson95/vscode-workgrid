/**
 * The ticket a task is about.
 *
 * A promotion check is scoped by ticket — `Test-WorkPromoted.ps1` finds this task's
 * commits among everyone else's on a shared branch by matching the reference in each
 * subject line, and **fails when it matches nothing**, because an existence check that
 * passes on finding nothing passes in exactly the case it exists to catch.
 *
 * That scoping was fed `${taskName}`, so it worked only where the name happened to
 * carry a reference. A real task called "Nissan GB - Data Load - Rescura" failed its
 * UAT promotion with exit 4 while every commit on its branch said `NMGB-2534` — the
 * ticket existed everywhere except the one place the check looked. Six of eight live
 * tasks had no reference in their name, so it was not a one-off.
 *
 * `origin.ref` is the answer because it already exists for this: it is set when a task
 * is started from a suggestion or linked to one, it is what the row displays, and it is
 * how the task is referred to everywhere outside the extension. A *name* is a label
 * people edit, and editing one must not silently unscope a check.
 *
 * Pure and vscode-free.
 */

/**
 * `PROJECT-123`.
 *
 * Deliberately the same shape `Test-WorkPromoted.ps1` matches, because the two have to
 * agree: the harness deciding one string is a ticket and the script deciding it is not
 * fails the check with a message about the wrong thing. Upper case only, matching the
 * script — a lower-case match here would substitute a reference the script then refuses.
 */
export const TICKET_PATTERN = /[A-Z][A-Z0-9]+-[0-9]+/;

/** The first ticket reference in some text, or undefined. */
export function findTicketReference(text: string | undefined): string | undefined {
  return text ? (TICKET_PATTERN.exec(text)?.[0] ?? undefined) : undefined;
}

/**
 * The task's ticket: what it was linked to, else whatever its name carries.
 *
 * The fallback is what makes this safe to adopt. Every route today passes `${taskName}`
 * and works wherever the name holds a reference; reading the name second means those
 * keep working untouched, and a linked task simply stops depending on how it was named.
 *
 * The link wins when both exist, because it was chosen deliberately and a name was not.
 * A task named for one ticket and linked to another is a task somebody repointed, and
 * `setTaskOrigin` refuses to repoint a link precisely so that the deliberate one is the
 * one to trust.
 */
export function taskTicket(task: {
  name: string;
  origin?: { ref: string };
}): string | undefined {
  return findTicketReference(task.origin?.ref) ?? findTicketReference(task.name);
}
