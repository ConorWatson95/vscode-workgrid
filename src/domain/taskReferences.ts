/**
 * The documents that govern a task, named by the operator.
 *
 * Measured 14 Aug 2026 across eight live pipelines: the largest single cause of
 * corrected work was a stage that had an authoritative specification available and
 * never opened it. On one task the layout came from tab 3 of a wireframe
 * spreadsheet, and the stage built it from the nearest prior implementation
 * instead — costing five corrections, and hitting `Plan` and `Implement the data`
 * *separately*, because subtask-per-session means each stage rediscovers the gap
 * rather than inheriting the fix.
 *
 * This is squarely what `StageContext` is for. Which document governs a piece of
 * work is a deterministic fact the operator holds and no cold session can derive:
 * it is not in the diff, not in the branch, and usually not in the brief. Left
 * unstated, a capable model does the reasonable thing and copies the closest
 * existing feature — which is precisely the failure, and one the stage cannot
 * detect it has committed.
 *
 * Deliberately *not* discovered by scanning the repository for likely-looking
 * documents. A guessed reference is worse than none: it would be stated to every
 * stage with the same authority as one the operator chose, and being told the wrong
 * document is authoritative is the one error this exists to prevent.
 */

/** A document the operator says governs this task. */
export interface TaskReference {
  /**
   * Where it is: a path relative to the repository root, or a URL.
   *
   * Not validated as an existing file. References are frequently not in the
   * repository at all — a shared spreadsheet, a Confluence page, a ticket
   * attachment — and refusing those would exclude exactly the documents that
   * caused the failure. A reference the stage cannot open is a thing it must ask
   * about, which `referenceGuidance` tells it to do.
   */
  path: string;
  /**
   * Which part of it applies.
   *
   * The reason this field exists rather than being folded into the path: the
   * real case was "tab 3 of Purchases vs Sales Mock-up 20.03.26.xlsx". A stage
   * given the workbook and not the tab has been handed the same ambiguity in a
   * smaller box.
   */
  note?: string;
  /** When it was added, so the record says when the operator made the claim. */
  at: string;
}

/**
 * Compares two references for identity.
 *
 * Case- and separator-insensitive because a path is typed by hand and Windows
 * offers three spellings of the same file. Two entries for one document would
 * both be stated to every stage, which reads as two documents that happen to
 * agree.
 */
function referenceKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Adds a reference, replacing any existing entry for the same document.
 *
 * Replacing rather than rejecting: re-adding a path is how an operator corrects
 * the note on it, and the alternative is remove-then-add for a one-word change.
 * Returns a new array — the immutability rule the domain transitions follow.
 */
export function addReference(
  existing: readonly TaskReference[] | undefined,
  reference: { path: string; note?: string },
  at: string,
): TaskReference[] {
  const path = reference.path.trim();
  const note = reference.note?.trim();
  const entry: TaskReference = { path, at, ...(note ? { note } : {}) };
  const rest = (existing ?? []).filter(
    (candidate) => referenceKey(candidate.path) !== referenceKey(path),
  );
  return [...rest, entry];
}

/** Drops a reference by path, leaving the rest in order. */
export function removeReference(
  existing: readonly TaskReference[] | undefined,
  path: string,
): TaskReference[] {
  return (existing ?? []).filter(
    (candidate) => referenceKey(candidate.path) !== referenceKey(path),
  );
}

/**
 * Reads persisted references, dropping entries that cannot be used.
 *
 * An entry with no path names no document, so it can only produce a line telling
 * a stage that something unnameable is authoritative. Dropped rather than
 * repaired, since there is nothing to repair it from — and unlike a route or a
 * rule, a missing reference degrades to the behaviour that existed before this
 * field did.
 */
export function normaliseReferences(value: unknown): TaskReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      path: typeof entry.path === "string" ? entry.path.trim() : "",
      note: typeof entry.note === "string" && entry.note.trim() ? entry.note.trim() : undefined,
      at: typeof entry.at === "string" ? entry.at : "",
    }))
    .filter((entry) => entry.path.length > 0)
    .map((entry) => ({ path: entry.path, at: entry.at, ...(entry.note ? { note: entry.note } : {}) }));
  return entries.length > 0 ? entries : undefined;
}

/**
 * What a stage is told about the documents governing its task.
 *
 * Every clause here answers something a stage actually did wrong:
 *
 * - *before you use an existing feature as a template* — the observed failure was
 *   not skipping the spec in favour of nothing, it was skipping it in favour of a
 *   plausible neighbour. Naming that move is what makes the instruction bite.
 * - *the document decides behaviour, the code is a guide to style* — without a
 *   stated precedence a stage that reads both simply merges them, which is how a
 *   report ended up with Phase 2's layout and this task's data.
 * - *say so in your report* — a document that contradicts the brief is a fact the
 *   operator needs back, and the stage is the only thing that will ever see both.
 * - *stop and ask rather than proceeding from a similar feature* — the governing
 *   document is often a binary the session may not be able to open, and the whole
 *   defect is what a stage does when it cannot see the spec.
 *
 * Returns an empty array when there are none, so the caller adds nothing to the
 * prompt: a heading followed by no documents invites the model to go looking for
 * some.
 */
export function referenceGuidance(references: readonly TaskReference[] | undefined): string[] {
  if (!references || references.length === 0) return [];
  return [
    "",
    "These documents govern this task. Read the relevant parts before you start, and",
    "before you use any existing feature in the code as a template:",
    ...references.map((reference) =>
      reference.note ? `- ${reference.path} — ${reference.note}` : `- ${reference.path}`,
    ),
    "",
    "Where one of these and an existing implementation disagree, the document decides",
    "behaviour, layout and naming; the code is a guide to style and structure only.",
    "Where one of these and the brief disagree, follow the document and say so in your",
    "report. If one is missing, or you cannot open it, ask — do not proceed from a",
    "similar feature instead.",
  ];
}
