import { markerLine, markerText } from "./replyMarkers";
import { StageKind, ALL_STAGE_KINDS } from "./taskRoute";
import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * Mutations a stage may propose to the live route, beyond repairing an earlier stage.
 *
 * `repairProposal` covers the case where an earlier stage got its work wrong. These two
 * cover the cases where nothing is wrong with anyone's work and the route is
 * nonetheless out of step with reality.
 *
 * ## Measured 1 Sep 2026, on 138 deferrals across 17 pipelines
 *
 * **`REVERIFY` — 15 items, 11 of them the same artefact.** A stage's output can be
 * invalidated by work that happens *after* it. `ec-preview.md` is a DEV deployment
 * preview: the implementation stage then changed the scripts it previewed, so the
 * approved artefact no longer described what would be deployed. The reviewing stages
 * noticed, correctly, eleven separate times — *"stale again, since the previewed
 * artifact changed"*, *"predates the current deploy/001"*, *"must be regenerated"* —
 * and every one was filed as a deferral and answered "Later", because a deferral is
 * the only thing a stage could say and settling one is a sentence, not an act.
 *
 * Eleven repetitions of one fact is what a missing operation looks like. The work was
 * never done, and the route deployed from a preview nobody had regenerated.
 *
 * **`INSERT` — 4 items.** Of 33 ownerless items, the operator said do-it-now on four
 * (*"Do it"*, *"Remove it"*, *"Sure"*) and pushed **17** out of the route entirely
 * (*"I'll check this"*, *"Later"*, *"Leave for now"*). So work belonging to no stage is
 * usually work that correctly *leaves* — which is why `DEFERRED` stays exactly as it
 * is and insertion is the narrower, opt-in path beside it, never a replacement.
 *
 * ## Reverify is an amendment, not a correction
 *
 * The distinction `Subtask.correction.upstream` exists to keep: three corrections is a
 * stage that got its own work wrong three times; three amendments is a stage that was
 * right each time and had the ground moved under it. A preview that previewed the
 * scripts as they stood was correct when it ran. So a reverify is recorded as an
 * amendment — the ledger stays honest, `withdrawAmendments` still restores, and no new
 * invalidation path is introduced. The only novelty is the *direction*: amendments have
 * so far flowed from a correction downstream, and this one flows backward from a later
 * stage's discovery.
 */

export const REVERIFY_MARKER = "REVERIFY";
export const INSERT_MARKER = "INSERT-STAGE";

const REVERIFY_RE = new RegExp(markerLine(`${REVERIFY_MARKER}:`), "gim");
const INSERT_RE = new RegExp(markerLine(`${INSERT_MARKER}:`), "gim");

/** A stage saying an earlier stage's output no longer describes reality. */
export interface ReverifyProposal {
  target: string;
  /** What changed under it. Becomes the amendment note. */
  reason: string;
}

/** A stage saying the route is missing work that nothing owns. */
export interface InsertProposal {
  kind: StageKind;
  name: string;
  intent: string;
}

export type MutationRuling<T> =
  | ({ admissible: true } & T)
  | { admissible: false; reason: string };

/**
 * Kinds a stage may propose inserting.
 *
 * Adding work or assurance is safe; removing it is not, and there is no vocabulary here
 * for removal at all. The exclusions are narrower than that, though, and each has its
 * own reason:
 *
 * - **`humanVerification`** — a gate is how a human's authority enters the route, so a
 *   stage proposing one is a stage deciding when it needs supervising. Adding one is
 *   safe in the sense that it adds a stop, and wrong in the sense that gates are the
 *   one thing the *project* declares. A route that needs another gate is a config edit.
 * - **`assessment`** — it exists to describe work that already happened at the moment a
 *   task enters the harness, and `approveStage` applies its conclusions by *skipping*
 *   stages. A stage that could propose one could propose skipping the rest of the route.
 */
const INSERTABLE: readonly StageKind[] = ALL_STAGE_KINDS.filter(
  (kind) => kind !== "humanVerification" && kind !== "assessment",
);

/** Reads `REVERIFY: <stage> — <what changed>` lines. */
export function parseReverifyProposals(reply: string | undefined): ReverifyProposal[] {
  return splitMarkers(reply, REVERIFY_RE).map(([target, reason]) => ({ target, reason }));
}

/** Reads `INSERT-STAGE: <kind> | <name> | <intent>` lines. */
export function parseInsertProposals(reply: string | undefined): InsertProposal[] {
  if (!reply) return [];
  const found: InsertProposal[] = [];
  for (const match of reply.matchAll(INSERT_RE)) {
    const parts = markerText(match[1], match[0])
      .split("|")
      .map((part) => part.trim());
    if (parts.length < 3) continue;
    const kind = parts[0].toLowerCase();
    const declared = INSERTABLE.find((k) => k.toLowerCase() === kind);
    // An unrecognised kind is dropped rather than defaulted. Defaulting would pick a
    // kind for a stage nobody declared, and the kind decides where it lands and what
    // evidence it owes.
    if (!declared || !parts[1] || !parts[2]) continue;
    found.push({ kind: declared, name: parts[1], intent: parts[2] });
  }
  return found;
}

/**
 * Decides whether a reverify may be applied, and to which stage.
 *
 * Legality is deliberately not `sendBackTo`, which is the authority for a *repair*: a
 * repair says an earlier stage was wrong, and the route decides who may say that. A
 * reverify says an artefact went stale, which is a statement of fact about a file
 * anybody can check, and the remedy is that stage doing its own job again.
 *
 * What it does require is that the target is a stage that has **settled** — a stage
 * still to run will read the current state anyway, so proposing one is a no-op that
 * would cost a session to discover.
 */
export function adjudicateReverify(
  pipeline: TaskPipeline,
  fromStageId: string,
  proposal: ReverifyProposal,
): MutationRuling<{ stage: TaskStage; reason: string }> {
  const index = pipeline.stages.findIndex((s) => s.id === fromStageId);
  if (index <= 0) return no("nothing precedes this stage");

  const target = findEarlier(pipeline, index, proposal.target);
  if (!target) return no(`no settled stage before this one is called "${proposal.target}"`);
  if (target.status !== "passed") {
    return no(`"${target.name}" is ${target.status}, so it will read the current state anyway`);
  }
  if (!proposal.reason.trim()) return no("a reverify must say what changed under it");

  return { admissible: true, stage: target, reason: proposal.reason.trim() };
}

/**
 * Decides whether a stage may be inserted, and where it goes.
 *
 * **The position is derived, never proposed.** `ruleInsertionIndex` already answers
 * "where does work of this kind belong" — as early as the work allows, no later than
 * the first unresolved barrier, floored at the frontier so nothing lands behind a stage
 * that has run. Letting a stage choose its own index is the generic graph language this
 * runtime has no evidence it needs, and it is the one degree of freedom that could put
 * a stage in front of a gate that has already passed.
 *
 * **A gate is always required.** An inserted stage is the only stage in a route that no
 * human declared, so it is the last one that should be able to pass unlooked-at. It is
 * therefore created with `requiresApproval` and never `authority: "evidence"` — the
 * evidence gate is a statement the project made about a stage it wrote, and it cannot
 * carry over to a stage the project has never seen.
 */
export function adjudicateInsert(
  pipeline: TaskPipeline,
  fromStageId: string,
  proposal: InsertProposal,
  insertionIndex: (stages: readonly TaskStage[], kind: StageKind) => number,
): MutationRuling<{ stage: TaskStage; index: number }> {
  const from = pipeline.stages.find((s) => s.id === fromStageId);
  if (!from) return no("no such stage");

  const name = proposal.name.trim();
  const intent = proposal.intent.trim();
  if (!name || !intent) return no("an inserted stage needs a name and an objective");

  // Matched on the name, because a stage proposing work the route already contains is
  // the commonest wrong proposal — `deferralOwnership` exists because stages routinely
  // describe work while naming the stage that owns it. Refused rather than deduplicated
  // silently, so the reason says the route already covers it.
  const existing = pipeline.stages.find(
    (s) => s.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing) return no(`the route already has a stage called "${existing.name}"`);

  const index = insertionIndex(pipeline.stages, proposal.kind);
  if (index < 0 || index > pipeline.stages.length) return no("the route has nowhere to put it");

  const stage: TaskStage = {
    id: uniqueId(pipeline, proposal.kind),
    name,
    kind: proposal.kind,
    status: "pending",
    intent,
    splittable: false,
    // Always. See above: nobody declared this stage, so nobody has said it may pass
    // without being read.
    requiresApproval: true,
    subtasks: [],
    insertedBecause: {
      stageId: from.id,
      stageName: from.name,
      reason: intent,
    },
  };

  return { admissible: true, stage, index };
}

/**
 * An id nothing else in the pipeline holds.
 *
 * Prefixed so an inserted stage is recognisable in a log, a report and a state file
 * without reading its provenance — the same courtesy `addedByRule` stages get from
 * their ids in practice.
 */
function uniqueId(pipeline: TaskPipeline, kind: StageKind): string {
  const base = `inserted-${kind.toLowerCase()}`;
  const taken = new Set(pipeline.stages.map((s) => s.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function findEarlier(
  pipeline: TaskPipeline,
  index: number,
  wanted: string,
): TaskStage | undefined {
  const name = wanted.trim().toLowerCase();
  return pipeline.stages
    .slice(0, index)
    .find((s) => s.id.toLowerCase() === name || s.name.trim().toLowerCase() === name);
}

/** Marker lines of the form `<target> — <rest>`, tolerant about the separator. */
function splitMarkers(reply: string | undefined, re: RegExp): [string, string][] {
  if (!reply) return [];
  const out: [string, string][] = [];
  for (const match of reply.matchAll(re)) {
    const split = /^(.+?)\s*(?:—|–|-{1,2}|:)\s+(.*)$/.exec(markerText(match[1], match[0]));
    if (!split) continue;
    const target = split[1].trim();
    const rest = split[2].trim();
    if (target && rest) out.push([target, rest]);
  }
  return out;
}

function no(reason: string): { admissible: false; reason: string } {
  return { admissible: false, reason };
}
