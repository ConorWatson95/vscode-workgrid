import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";
import { itemsForGate } from "./checklistScope";

/**
 * Which checklist items a machine already answered, and which nothing can.
 *
 * A behaviour review writes a checklist because a human has to exercise the change.
 * Measured on this repository's live routes, **41 of 127 site-scoped items are "the
 * export buttons appear and both download"** — a person clicking a button a browser
 * check clicks on every run. Those are not verification, they are transcription, and
 * they are paid for on every task by the one person the KPI is about.
 *
 * The other 86 are the interesting half, and they split two ways that the checklist
 * could not previously tell apart: items a check *could* answer and nobody wrote one
 * for, and items no check can answer at all. Both read identically as an unticked
 * line, so the second kind — the real gaps — were invisible inside the noise of the
 * first.
 *
 * So an item names the check that answers it, the check records whether it ran, and
 * this module joins the two. Four rules, each load-bearing:
 *
 * - **An item names a check; a check never claims an item.** The review writing the
 *   item knows what it wants exercised; the suite does not. A check advertising "I
 *   answer items about exports" is the fuzzy matching `sendBackTargets` already
 *   refused once — a near-match that ticks the wrong item asserts a verification
 *   nobody performed, which is strictly worse than asking for it again.
 * - **The outcome record proves the check ran**, and an exit code does not. A suite
 *   exiting 0 says every check it *contains* passed; an item naming a check the
 *   manifest does not contain would be ticked by a run that never tested it. That is
 *   the silent-non-firing failure this codebase has now paid for three times, and
 *   here it would arrive wearing a tick.
 * - **A failing suite still ticks what passed.** Outcomes are per check, so a run
 *   where one of four failed has genuinely answered the other three. Withholding them
 *   would hand the operator, at the exact moment a check has failed, a longer list of
 *   things to do by hand.
 * - **A gap is counted and named, never blocking.** An item nothing covers is the
 *   ordinary case today, so holding on one would hold every gate of every route —
 *   which is how a signal like this gets switched off. What it owes is the sentence
 *   that makes it countable, so the number can be driven down deliberately.
 *
 * Absence means unchanged throughout: a route declaring no `checkResults` and a
 * review writing no `[check: …]` tag leave every gate behaving exactly as before.
 *
 * Pure and vscode-free.
 */

/** What a check run reported about one declared check. */
export interface CheckOutcome {
  /** The check's id, as the task's own manifest declares it. */
  id: string;
  passed: boolean;
}

/** An item, with what is known about whether a machine has answered it. */
export interface ItemCoverage {
  item: ChecklistItem;
  /**
   * `"answered"` — it names a check that ran and passed.
   * `"failed"` — it names a check that ran and did not pass.
   * `"missing"` — it names a check, and no run of this gate's suite contains it.
   * `"gap"` — it names no check at all.
   */
  state: "answered" | "failed" | "missing" | "gap";
}

/**
 * Splits a `[check: <id>]` tag off the end of an item's text.
 *
 * Trailing rather than leading, because the leading bracket is `splitScopeTag`'s and
 * an item legitimately carries both — `[dev-site] the export opens [check: pyramid]`.
 * Matched on the literal word so an item ending in any other bracketed aside keeps it:
 * a review writing `… (Excel only)` is describing the item, and quietly removing that
 * would change what a person is being asked to do.
 */
export function splitCheckTag(text: string): { text: string; coveredBy?: string } {
  const match = /^(.*?)\s*[[(]\s*check\s*[:=]\s*([^\])]{1,120}?)\s*[\])]\s*$/is.exec(text);
  if (!match) return { text: text.trim() };

  const id = match[2].trim();
  const rest = match[1].trim();
  // A bullet that was nothing but the tag names a check and asks for nothing, which is
  // not an item. Left as written rather than dropped here, so the caller's own
  // empty-text guard decides — the rule `splitScopeTag` follows.
  if (!id) return { text: text.trim() };
  return { text: rest, coveredBy: id };
}

/** Case- and space-insensitive, because a manifest id and a prose tag are typed twice. */
function sameId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * The outcomes recorded against a gate, newest run only.
 *
 * A stage re-verified after a fix holds one list, not a history: the question is what
 * is true now, and an older run's pass certifies a version of the worktree that has
 * moved — the distinction `reopenAfter` draws between context and certification.
 */
export function outcomesOf(stage: TaskStage | undefined): CheckOutcome[] {
  return stage?.checkOutcomes ?? [];
}

/** Every item this gate must answer for, with what the last check run said about it. */
export function coverageForGate(
  pipeline: TaskPipeline,
  stageId: string,
): ItemCoverage[] {
  const gate = pipeline.stages.find((stage) => stage.id === stageId);
  const outcomes = outcomesOf(gate);

  return itemsForGate(pipeline, stageId).map((item) => {
    if (!item.coveredBy) return { item, state: "gap" as const };
    const outcome = outcomes.find((candidate) => sameId(candidate.id, item.coveredBy!));
    if (!outcome) return { item, state: "missing" as const };
    return { item, state: outcome.passed ? ("answered" as const) : ("failed" as const) };
  });
}

/**
 * The items a passing check has answered, ready to tick.
 *
 * Returned rather than applied, the rule `recordAssessments` follows: deciding what a
 * run proved and changing the pipeline are two acts, and keeping them apart is what
 * lets a caller show the operator the list before it is applied.
 */
export function itemsAnsweredByChecks(
  pipeline: TaskPipeline,
  stageId: string,
): ChecklistItem[] {
  return coverageForGate(pipeline, stageId)
    .filter((entry) => entry.state === "answered")
    // An action is a step only the operator can take, and no browser check performs
    // one. A suite that happened to exercise the same page has not opened the pull
    // request, so ticking it would be a false statement rather than a judgement call
    // — which is exactly what `kind: "action"` was introduced to keep apart.
    .filter((entry) => (entry.item.kind ?? "verify") === "verify")
    .map((entry) => entry.item);
}

/**
 * Reads the file a stage's `checkResults` names.
 *
 * Tolerant in one direction only. Anything it cannot read as a list of `{id, passed}`
 * yields **nothing**, never a partial guess: every outcome here becomes a tick, and a
 * tick is a claim that somebody verified something. Absence of measurement is not
 * permission to act — so a malformed file leaves every item exactly as unverified as
 * it was, which is the state a person can see and correct.
 */
export function parseCheckResults(text: string | undefined): CheckOutcome[] {
  if (!text?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const checks = (parsed as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];

  const outcomes: CheckOutcome[] = [];
  for (const entry of checks) {
    const id = (entry as { id?: unknown })?.id;
    const passed = (entry as { passed?: unknown })?.passed;
    // `passed` must be a real boolean. A missing field read as falsy would report a
    // check that ran fine as having failed, and one read as truthy would tick an item
    // on the strength of a typo.
    if (typeof id !== "string" || !id.trim() || typeof passed !== "boolean") continue;
    outcomes.push({ id: id.trim(), passed });
  }
  return outcomes;
}

/** Replaces what a stage knows about its checks with this run's account. */
export function recordCheckOutcomes(
  pipeline: TaskPipeline,
  stageId: string,
  outcomes: readonly CheckOutcome[],
): TaskPipeline {
  const stages = pipeline.stages.map((stage) =>
    stage.id === stageId ? { ...stage, checkOutcomes: [...outcomes] } : stage,
  );
  return { ...pipeline, stages };
}

/**
 * Ticks the items this gate's own checks have answered.
 *
 * Three rules:
 *
 * - **Never unticks.** A person who ticked an item made a statement, and a later run
 *   finding its check red does not retract it — the failing check holds the stage on
 *   its own account, which is the honest place for that fact.
 * - **Never an `action`.** A browser check has not opened a pull request or registered
 *   anything in a third party's console, whatever page it happened to exercise. That
 *   is the distinction `kind: "action"` exists to hold, and ticking one would be a
 *   false statement rather than a judgement call.
 * - **Marked as the machine's**, via `checkedBy`. A checklist both a person and a
 *   suite have signed is only honest if the report can say which did what.
 */
export function tickAnsweredItems(
  pipeline: TaskPipeline,
  stageId: string,
  at: string,
): { pipeline: TaskPipeline; ticked: ChecklistItem[] } {
  const answered = itemsAnsweredByChecks(pipeline, stageId);
  if (answered.length === 0) return { pipeline, ticked: [] };

  const wanted = new Set(answered.map((item) => item.id));
  const ticked: ChecklistItem[] = [];

  const stages = pipeline.stages.map((stage) => {
    if (!stage.checklist?.some((item) => wanted.has(item.id))) return stage;
    return {
      ...stage,
      checklist: stage.checklist.map((item) => {
        if (!wanted.has(item.id) || item.checked) return item;
        const next: ChecklistItem = { ...item, checked: true, checkedBy: "check", checkedAt: at };
        ticked.push(next);
        return next;
      }),
    };
  });

  if (ticked.length === 0) return { pipeline, ticked: [] };
  return { pipeline: { ...pipeline, stages }, ticked };
}

/** How this gate's items divide, for the sentence the gate shows. */
export interface CoverageSummary {
  answered: number;
  failed: number;
  missing: number;
  gaps: number;
  total: number;
}

export function summariseCoverage(
  pipeline: TaskPipeline,
  stageId: string,
): CoverageSummary | undefined {
  const coverage = coverageForGate(pipeline, stageId);
  if (coverage.length === 0) return undefined;

  const count = (state: ItemCoverage["state"]) =>
    coverage.filter((entry) => entry.state === state).length;

  return {
    answered: count("answered"),
    failed: count("failed"),
    missing: count("missing"),
    gaps: count("gap"),
    total: coverage.length,
  };
}

/**
 * The sentence a gate shows about its own coverage.
 *
 * Silent when nothing is covered and nothing claims to be, the rule
 * `summariseEvidence` follows: a gate on a route with no browser checks would
 * otherwise carry "0 of 6 answered by checks" on every render, which reads as
 * decoration and is then not read at all. A *gap* is only worth naming once something
 * else on the list is covered, because that is the point at which the difference
 * between "nobody automated this" and "nothing can" becomes a decision.
 */
export function formatCoverageLine(summary: CoverageSummary | undefined): string | undefined {
  if (!summary) return undefined;
  const covered = summary.answered + summary.failed + summary.missing;
  if (covered === 0) return undefined;

  const parts = [`${summary.answered} of ${summary.total} answered by checks that passed`];
  if (summary.failed > 0) parts.push(`${summary.failed} by checks that failed`);
  if (summary.missing > 0) {
    parts.push(
      `${summary.missing} naming a check the last run did not contain — those are unverified`,
    );
  }
  if (summary.gaps > 0) {
    parts.push(
      `${summary.gaps} with no check behind ${summary.gaps === 1 ? "it" : "them"}`,
    );
  }
  return parts.join(", ") + ".";
}

/**
 * Says which check answers an item, or that nothing does.
 *
 * The manual counterpart of the `[check: …]` tag, and the reason it exists is that the
 * tag only reaches checklists written *after* a project adopted coverage. Every item
 * already in flight was raised by a review that was never asked the question, so
 * without this the feature arrives one task late and the existing lists stay a pile
 * nobody can sort. Re-running the review to tag them would discard the gate's own
 * checklist, which is a far larger act than recording one fact about one line.
 *
 * Clearing is offered for the same reason `noteChecklistItem` allows an empty note: a
 * wrong id is worse than none, because an item pointing at a check that does not run
 * reports as unverified rather than as the gap it actually is.
 *
 * Never ticks or unticks. Whether this now settles the item is
 * `tickAnsweredItems`' question, and keeping them apart is what lets a caller attach a
 * check to an item whose run has not happened yet.
 */
export function setItemCoverage(
  pipeline: TaskPipeline,
  itemId: string,
  coveredBy: string | undefined,
): TaskPipeline {
  let found = false;
  const stages = pipeline.stages.map((stage) => {
    if (!stage.checklist?.some((item) => item.id === itemId)) return stage;
    found = true;
    return {
      ...stage,
      checklist: stage.checklist.map((item) => {
        if (item.id !== itemId) return item;
        const next = { ...item };
        if (coveredBy?.trim()) next.coveredBy = coveredBy.trim();
        else delete next.coveredBy;
        return next;
      }),
    };
  });
  return found ? { ...pipeline, stages } : pipeline;
}

/**
 * The check ids this gate's last run actually recorded, for offering as choices.
 *
 * Read from the run rather than from the project's manifest, deliberately. The
 * manifest is a file in the worktree that the harness has no business parsing — its
 * format belongs to the project's own tooling — and what matters here is the same
 * thing that matters at tick time: which checks *ran*. Offering an id from a manifest
 * that the suite never executed would let an operator attach an item to a check that
 * cannot answer it, which is the state this whole mechanism reports as unverified.
 */
export function offeredCheckIds(stage: TaskStage | undefined): CheckOutcome[] {
  return [...outcomesOf(stage)].sort((left, right) => left.id.localeCompare(right.id));
}
