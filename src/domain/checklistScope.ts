import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * Which verification gate answers for which checklist item.
 *
 * One pooled list could not express the thing a real route actually needs. The same
 * change has to be exercised twice, for different reasons: once locally against the
 * DEV database, which asks whether the change *behaves*, and again on the deployed
 * DEV site, which asks whether it works where people will see it — and that second
 * pass is the only thing that catches configuration, permissions, a missing menu
 * item, or the deployment itself having gone wrong. `outstandingChecklist` collected
 * every unchecked item across the whole pipeline, so the **first** gate absorbed all
 * of them and every later gate had nothing left to ask for. The route could describe
 * two verifications and only ever perform one.
 *
 * Two rules carry the safety here, and both are about an item never escaping:
 *
 * - **Absent scopes mean the old behaviour, exactly.** If no gate in the pipeline
 *   declares a `checklistScope`, every unchecked item goes to the first unresolved
 *   gate — which is what happened before this module existed. Existing pipelines and
 *   every route that has not opted in are untouched, and there is no migration.
 * - **An unscoped item is assigned, never dropped.** Once scoping is active, an item
 *   whose scope is absent, misspelled, or names a gate this route does not have goes
 *   to the *last* scoped gate. Silently discarding it would turn a tagging mistake
 *   into work nobody verifies, which is the failure the checklist exists to prevent.
 *   The last scoped gate rather than the last gate of all, so a mistagged item stays
 *   inside the region the route was scoping and does not drift onto a live sign-off.
 *
 * Pure and vscode-free.
 */

/** A verification gate, in route order, with whatever it declared. */
export interface ChecklistGate {
  stageId: string;
  stageName: string;
  /** Declared label, absent when this gate did not opt in. */
  scope?: string;
  /** True while this gate has not yet passed, so it can still be assigned items. */
  unresolved: boolean;
}

function normalise(scope: string | undefined): string | undefined {
  const trimmed = scope?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/** True when a stage settled one way or another and can take no more items. */
function isResolved(stage: TaskStage): boolean {
  return stage.status === "passed" || stage.status === "skipped";
}

/** Every verification gate in the pipeline, in order. */
export function checklistGates(pipeline: TaskPipeline): ChecklistGate[] {
  return pipeline.stages
    .filter((stage) => stage.kind === "humanVerification")
    .map((stage) => ({
      stageId: stage.id,
      stageName: stage.name,
      scope: normalise(stage.checklistScope),
      unresolved: !isResolved(stage),
    }));
}

/**
 * True when at least one gate has opted in to scoping.
 *
 * The switch that keeps this backwards-compatible. A route declaring nothing gets the
 * pooled behaviour it always had, so nothing about an existing pipeline changes by
 * being read with this code loaded.
 */
export function scopingActive(gates: readonly ChecklistGate[]): boolean {
  return gates.some((gate) => gate.scope !== undefined);
}

/** The scopes a behaviour review may tag items with, in route order, deduplicated. */
export function declaredScopes(pipeline: TaskPipeline): string[] {
  const seen: string[] = [];
  for (const gate of checklistGates(pipeline)) {
    if (gate.scope && !seen.includes(gate.scope)) seen.push(gate.scope);
  }
  return seen;
}

/**
 * The gate that answers for a given scope.
 *
 * Prefers an unresolved gate: on a route that verifies the same scope twice — a DEV
 * sign-off and a UAT acceptance both looking at a site — an item raised after the
 * first has passed belongs to the one still to come. Falls back to a resolved gate
 * only so that `gateFor` can still explain where a ticked item was answered.
 */
export function gateFor(
  gates: readonly ChecklistGate[],
  scope: string | undefined,
): ChecklistGate | undefined {
  if (gates.length === 0) return undefined;

  if (!scopingActive(gates)) {
    // The pre-scope rule, kept verbatim: the first gate still to run answers for
    // everything.
    return gates.find((gate) => gate.unresolved) ?? gates[gates.length - 1];
  }

  const wanted = normalise(scope);
  if (wanted) {
    const matching = gates.filter((gate) => gate.scope === wanted);
    if (matching.length > 0) {
      return matching.find((gate) => gate.unresolved) ?? matching[matching.length - 1];
    }
  }

  // Unscoped, or scoped to something this route does not have. Assigned to a gate that
  // declared a scope rather than dropped — an item nobody verifies is worse than an item
  // verified in the wrong place, and this way a tagging mistake is visible at a gate
  // instead of silent.
  //
  // The *last unresolved* one, not simply the last. A route scopes its early gates and
  // keeps later ones for UAT and live, so an item raised after the last scoped gate has
  // already passed would be assigned to a closed gate and then block nothing at all —
  // silently unverified, which is the one outcome this fallback exists to prevent. Falls
  // back to the last scoped gate when every one has passed, so `gateFor` can still say
  // where a ticked item was answered.
  const scoped = gates.filter((gate) => gate.scope !== undefined);
  const open = scoped.filter((gate) => gate.unresolved);
  return open[open.length - 1] ?? scoped[scoped.length - 1];
}

/**
 * Unchecked items this gate is responsible for.
 *
 * Items from skipped stages are excluded, matching `outstandingChecklist`: they gate
 * nothing, and counting them would oblige evidence about work that is not being done.
 */
export function itemsForGate(
  pipeline: TaskPipeline,
  stageId: string,
): ChecklistItem[] {
  const gates = checklistGates(pipeline);
  if (!gates.some((gate) => gate.stageId === stageId)) return [];

  return pipeline.stages
    .filter((stage) => stage.status !== "skipped")
    .flatMap((stage) => stage.checklist ?? [])
    .filter((item) => !item.checked)
    .filter((item) => gateFor(gates, item.scope)?.stageId === stageId);
}

/**
 * How unchecked items are spread across the gates, for display.
 *
 * Gates with nothing to do are included: a route that declares a `dev-site`
 * verification and produced no items for it is worth seeing, because the likeliest
 * cause is a behaviour review that ignored the scope instruction — and that reads
 * identically to "nothing needed checking there" unless the gate is listed.
 */
export function checklistByGate(
  pipeline: TaskPipeline,
): { gate: ChecklistGate; items: ChecklistItem[] }[] {
  return checklistGates(pipeline).map((gate) => ({
    gate,
    items: itemsForGate(pipeline, gate.stageId),
  }));
}

/**
 * Items nobody will be asked about, which must always be empty.
 *
 * A guard rather than a feature: every unchecked item should resolve to some gate, and
 * this is what proves it for a given pipeline. Non-empty means either the route has no
 * verification gate at all — in which case the route is invalid, since a route must end
 * at an approval — or the resolution above has a hole.
 */
export function unassignedItems(pipeline: TaskPipeline): ChecklistItem[] {
  const gates = checklistGates(pipeline);
  return pipeline.stages
    .filter((stage) => stage.status !== "skipped")
    .flatMap((stage) => stage.checklist ?? [])
    .filter((item) => !item.checked)
    .filter((item) => gateFor(gates, item.scope) === undefined);
}

/**
 * Splits a scope tag off the front of a checklist item, when the review wrote one.
 *
 * Tolerant on purpose, and matched against the scopes the route actually declared
 * rather than anything bracketed. A review that writes `[Excel]` or
 * `[regression risk]` is describing the item, not naming a gate, and stripping that
 * would quietly change what the item says. So an unrecognised tag is left in the text
 * and the item is treated as unscoped — which assigns it to the last scoped gate
 * rather than losing it.
 */
export function splitScopeTag(
  text: string,
  declared: readonly string[],
): { text: string; scope?: string } {
  const match = /^\s*[[(]\s*([^\])]{1,40}?)\s*[\])]\s*(.*)$/s.exec(text);
  if (!match) return { text: text.trim() };

  const candidate = normalise(match[1]);
  const rest = match[2].trim();
  if (!candidate || !rest) return { text: text.trim() };

  const known = declared.map((scope) => normalise(scope)).filter(Boolean) as string[];
  if (!known.includes(candidate)) return { text: text.trim() };

  return { text: rest, scope: candidate };
}
