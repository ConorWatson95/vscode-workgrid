import { ReviewRule } from "./reviewRules";
import {
  ChecklistAudience,
  RouteDefinition,
  sendBackEntryKind,
  StageKind,
} from "./taskRoute";
import {
  DiscardedRun,
  TaskPipeline,
  TaskStage,
  truncateHandoff,
} from "./taskPipeline";
import { settleDiscardedDeferrals, stageFromDefinition } from "./pipelineEngine";
import { stageUsage } from "./stageUsage";

/**
 * Reloads stage definitions from current project config, and re-opens a stage
 * that has already run so it can be done again properly.
 *
 * Both exist because a pipeline is a **snapshot**. Picking a route fixes the
 * stages the work travels through, which is right — a route edited mid-flight must
 * not rewrite a task already moving through it. But it also froze every stage's
 * `intent`, so fixing a wrong instruction meant recreating the task and losing its
 * history. The observed case: a deployment stage whose intent omitted a scoping
 * flag, so the stage deployed every project instead of one.
 *
 * The rule that makes this safe: **a stage that has already run keeps what it ran
 * with.** History has to stay truthful, so refreshing only touches stages that
 * have not started, and reverting is an explicit act that clears the run it is
 * discarding.
 *
 * Pure and vscode-free.
 */

export interface StageDefinitionSource {
  routes: readonly RouteDefinition[];
  rules: readonly ReviewRule[];
}

/**
 * The parts of a stage that may be reloaded.
 *
 * Deliberately only wording and execution knobs. `splittable` is excluded: it
 * decides how many subtasks a stage has, so changing it would reshape a pipeline
 * rather than correct an instruction — and a non-splittable stage already carries a
 * synthesized subtask that would then be wrong. Structure stays snapshotted; only
 * what the agent is told, and which model tells it, is refreshed.
 *
 * `workflow` is absent because it is a *subtask* field, not a stage one.
 */
const REFRESHABLE = ["intent", "model", "verify", "planFile"] as const;

/**
 * Adds stages a route gained after this pipeline was created.
 *
 * The gap this closes: a route is instantiated once, at task creation, so correcting a
 * route that was missing a step left every task already in flight without it — and the
 * only remedies were to do the step by hand or throw the task away. The argument for
 * doing this is the one that already justifies `refreshPendingStages`: correcting a
 * route should not require a new task.
 *
 * Two rules keep it safe, and both matter:
 *
 * - **Only ahead of the frontier.** A stage is inserted only at a position after every
 *   stage that has started, passed, failed, been skipped or is awaiting approval.
 *   Inserting behind one would mean a route claims to have run a step it never ran,
 *   which is the failure this whole area exists to prevent. A stage whose route
 *   position falls behind the frontier is reported as `tooLate` rather than dropped
 *   silently or forced in.
 * - **Nothing is ever removed.** A stage the route no longer defines stays, because it
 *   may already have run and the pipeline is the record of what happened.
 *
 * Positioned by route order relative to the stages already present, so a stage lands
 * where the route says rather than at the end.
 */
export function addMissingStages(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
): { pipeline: TaskPipeline; added: string[]; tooLate: string[] } {
  const route = source.routes.find((r) => r.id === pipeline.routeId);
  if (!route) return { pipeline, added: [], tooLate: [] };

  const present = new Set(pipeline.stages.map((s) => s.id));
  const missing = route.stages.filter((definition) => !present.has(definition.id));
  if (missing.length === 0) return { pipeline, added: [], tooLate: [] };

  // Everything at or before this index has a history to protect.
  const lastSettled = pipeline.stages.reduce(
    (last, stage, at) => (stage.status === "pending" ? last : at),
    -1,
  );
  const frontier = lastSettled + 1;

  const stages = [...pipeline.stages];
  const added: string[] = [];
  const tooLate: string[] = [];

  for (const definition of missing) {
    // Where the route puts it: after the nearest earlier route stage that the pipeline
    // already has. Recomputed each time, so two new adjacent stages keep their order.
    const routeIndex = route.stages.findIndex((s) => s.id === definition.id);
    let at = 0;
    for (let before = routeIndex - 1; before >= 0; before--) {
      const found = stages.findIndex((s) => s.id === route.stages[before].id);
      if (found !== -1) {
        at = found + 1;
        break;
      }
    }
    if (at < frontier) {
      tooLate.push(definition.id);
      continue;
    }
    stages.splice(at, 0, stageFromDefinition(definition));
    added.push(definition.id);
  }

  if (added.length === 0) return { pipeline, added: [], tooLate };
  return { pipeline: { ...pipeline, stages }, added, tooLate };
}

/**
 * Puts not-yet-started stages back into the order the route now declares.
 *
 * The half of route repair that was missing. `addMissingStages` covers a route that
 * gained a step; nothing covered a route that *reordered* the steps it already had —
 * and reordering is how the most consequential route corrections are expressed, because
 * the point of them is usually that one stage must happen before another.
 *
 * The observed case: `report-change` was corrected to deploy its SQL and have a human
 * verify the change locally *before* merging into the shared DEV branch. New tasks got
 * the fix. A task already in flight had the two new stages inserted correctly and kept
 * `Land on DEV` exactly where the old route put it — in front of the SQL deploy — so the
 * verification gate the correction existed to add ran after the change had already been
 * shared, which is precisely the state it was written to prevent. The pipeline disagreed
 * with config and nothing said so.
 *
 * Four rules, and each one is what keeps this from rewriting history:
 *
 * - **Only stages that have not begun.** A stage that ran, is running, failed, was
 *   skipped or is awaiting approval is pinned at its index. Moving one would reorder the
 *   record of what happened.
 * - **Only ahead of the frontier**, which follows from the above rather than being
 *   checked separately: the settled stages hold their slots, so nothing can cross one.
 * - **Only into slots pending route stages already occupy.** The movable stages are
 *   permuted among their own positions, so a pinned stage — settled, rule-added, or one
 *   the route no longer defines — never shifts by even one index.
 * - **Rule-added stages are left to `repositionRuleStages`.** Their position comes from
 *   `ruleInsertionIndex`, not from route order, so sorting them by a route that does not
 *   mention them would undo that placement.
 *
 * A stage the route reordered but which is already settled stays wrong, and stays
 * wrong deliberately: the only honest repair for that is `revertToStage`, which is a
 * human's call because it discards work.
 */
export function repositionRouteStages(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
): { pipeline: TaskPipeline; moved: string[] } {
  const route = source.routes.find((r) => r.id === pipeline.routeId);
  if (!route) return { pipeline, moved: [] };

  const routeIndexOf = new Map(route.stages.map((stage, at) => [stage.id, at]));

  // Which slots may be permuted. Everything else holds its index exactly.
  const slots: number[] = [];
  pipeline.stages.forEach((stage, at) => {
    if (!hasBegun(stage) && stage.addedByRule === undefined && routeIndexOf.has(stage.id)) {
      slots.push(at);
    }
  });
  if (slots.length < 2) return { pipeline, moved: [] };

  const reordered = slots
    .map((at) => pipeline.stages[at])
    .sort((a, b) => routeIndexOf.get(a.id)! - routeIndexOf.get(b.id)!);

  const stages = [...pipeline.stages];
  const moved: string[] = [];
  slots.forEach((at, which) => {
    stages[at] = reordered[which];
    if (stages[at].id !== pipeline.stages[at].id) moved.push(stages[at].id);
  });

  if (moved.length === 0) return { pipeline, moved: [] };
  return { pipeline: { ...pipeline, stages }, moved };
}

/**
 * Whether a stage has any history to protect.
 *
 * Status alone is not enough: a stage left `pending` whose first subtask has started is
 * a stage that is running, and `refreshPendingStages` has always checked both.
 */
function hasBegun(stage: TaskStage): boolean {
  return stage.status !== "pending" || stage.subtasks.some((s) => s.status !== "pending");
}

/**
 * Declarations about **who answers a gate**, which have to reach a stage already
 * standing at it.
 *
 * Separate from `REFRESHABLE` because the rule that protects history does not apply to
 * them, and applying it anyway is what made both of these fail silently. `intent` and
 * `model` are instructions *given to a run*, so a stage that has run must keep what it
 * ran with. A scope and an audience are neither: they say which gate reads an item and
 * whose job it is to answer, which is a fact about what happens **next** and says nothing
 * about what happened.
 *
 * Refreshed on any stage that has not *resolved*, therefore, rather than any stage that
 * has not *begun* — because a verification gate is `awaiting-approval` for its whole
 * useful life, and "has begun" excludes exactly the stages this exists to correct. Two
 * real failures, both found in one state file on 13 Aug 2026 with nine live tasks in it:
 *
 * - `checklistScope` was added to a project's route file, and five tasks already in
 *   flight kept `undefined` on every gate. They silently ran the pre-scope pooled
 *   behaviour, so the first gate absorbed every item and the later ones asked for
 *   nothing — the exact defect scoping was introduced to fix, still live in the tasks
 *   that predated it.
 * - `checklistAudience` was added, and the four tasks sitting at a DEV sign-off stayed in
 *   "Needs you" because their persisted stage had no audience to read.
 *
 * A **resolved** stage is left alone. Once a gate has passed, who answered it is history.
 */
const GATE_DECLARATIONS = ["checklistScope", "checklistAudience"] as const;

/**
 * Whether gate scopes can be brought into line without moving an existing item.
 *
 * A scope is a *routing* decision: `gateFor` sends an item to the gate whose scope it
 * names, and an item naming none to the last unresolved scoped gate. So backfilling
 * scopes onto the gates of a task whose items were written **before** scopes existed
 * re-routes every one of those items at once — and on a real route it re-routed eleven
 * DEV sign-off items onto `rc-live-verify-sm`, a live gate, because that was simply the
 * last unresolved scoped one. The gates matched config and the checklist was ruined.
 *
 * So scope is backfilled only when no unchecked item lacks one, which is exactly the
 * condition under which the change cannot alter any item's destination. `audience` is
 * never withheld: it says who answers a gate and routes nothing, so it is always safe.
 *
 * The items themselves are deliberately not tagged here. A scope is the behaviour
 * review's judgement about which environment can answer an item, and guessing it from
 * an item's wording is exactly the inference this codebase refuses to make elsewhere.
 * Re-running the review is the honest repair, and it is a human's call.
 */
function canBackfillScopes(pipeline: TaskPipeline): boolean {
  return !pipeline.stages
    .filter((stage) => stage.status !== "skipped")
    .flatMap((stage) => stage.checklist ?? [])
    .some((item) => !item.checked && !(item.scope ?? "").trim());
}

/** True when a stage has settled and can take no more items. */
function hasResolved(stage: TaskStage): boolean {
  return stage.status === "passed" || stage.status === "skipped";
}

/**
 * Reloads gate declarations for every unresolved stage.
 *
 * Deliberately *not* folded into `refreshPendingStages`: that function's contract is
 * "nothing that has begun is touched", and it is relied on. A second pass with its own
 * narrower field list and its own wider status rule keeps both rules legible rather than
 * making one of them conditional.
 *
 * Returns the pipeline unchanged when nothing differs, so callers can skip a save.
 */
export function refreshGateDeclarations(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
): { pipeline: TaskPipeline; changed: string[] } {
  const changed: string[] = [];
  const scopeSafe = canBackfillScopes(pipeline);

  const stages = pipeline.stages.map((stage) => {
    if (hasResolved(stage)) return stage;
    const definition = findDefinition(source, pipeline.routeId, stage);
    if (!definition) return stage;

    const updates: Partial<TaskStage> = {};
    for (const field of GATE_DECLARATIONS) {
      if (field === "checklistScope" && !scopeSafe) continue;
      const next = normalize(definition[field]);
      if (normalize(stage[field]) !== next) {
        (updates as Record<string, unknown>)[field] = next;
      }
    }
    if (Object.keys(updates).length === 0) return stage;

    changed.push(stage.id);
    return { ...stage, ...updates };
  });

  if (changed.length === 0) return { pipeline, changed: [] };
  return { pipeline: { ...pipeline, stages }, changed };
}

/**
 * Brings every not-yet-started stage into line with current config.
 *
 * Matched by id. A stage whose id is no longer in config keeps what it has rather
 * than being emptied — it is still going to run, and the pipeline is the source of
 * truth for that.
 *
 * Returns the pipeline unchanged when nothing differs, so callers can skip a save.
 */
export function refreshPendingStages(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
): { pipeline: TaskPipeline; changed: string[] } {
  const changed: string[] = [];

  const stages = pipeline.stages.map((stage) => {
    // Only stages that have not begun. A passed, failed or running stage must keep
    // the instruction it was actually given.
    if (stage.status !== "pending" || stage.subtasks.some((s) => s.status !== "pending")) {
      return stage;
    }
    const definition = findDefinition(source, pipeline.routeId, stage);
    if (!definition) return stage;

    const updates: Partial<TaskStage> = {};
    for (const field of REFRESHABLE) {
      const next = normalize(definition[field]);
      if (normalize(stage[field]) !== next) {
        (updates as Record<string, unknown>)[field] = next;
      }
    }
    // Handled apart from the scalar fields because comparing arrays by `!==`
    // compares references, so every refresh would report a change and rewrite the
    // state file on every advance.
    const requiredNext = definition.requiredMcpServers;
    if (!sameNames(stage.requiredMcpServers, requiredNext)) {
      updates.requiredMcpServers =
        requiredNext && requiredNext.length > 0 ? [...requiredNext] : undefined;
    }

    if (Object.keys(updates).length === 0) return stage;

    changed.push(stage.id);
    const refreshed = { ...stage, ...updates };
    // A stage's prompt is derived from its intent, so a stale prompt would undo
    // the refresh for the very stage it was meant to fix.
    return {
      ...refreshed,
      subtasks: refreshed.subtasks.map((subtask) =>
        subtask.prompt === stage.intent
          ? { ...subtask, prompt: refreshed.intent }
          : subtask,
      ),
    };
  });

  return changed.length > 0 ? { pipeline: { ...pipeline, stages }, changed } : { pipeline, changed };
}

/**
 * Re-opens a stage and everything after it, discarding those runs.
 *
 * For the case where a stage has already run and got it wrong: the fix is in
 * config, and the stage needs doing again. Later stages go too, because they were
 * built on the output being discarded — leaving them passed would mean approving
 * work that no longer exists.
 *
 * Earlier stages are untouched, and so is the guidance the operator has given:
 * that is the thing most likely to be the reason for reverting.
 */
export function revertToStage(
  pipeline: TaskPipeline,
  stageId: string,
  /**
   * What is being discarded and why, recorded before it is thrown away.
   *
   * Optional so every existing caller keeps working, but a caller that omits it
   * loses the cost of the run it is discarding — which is how a task sent back six
   * times came to report the price of its last attempt and look calm.
   */
  discard?: {
    at: string;
    reason?: string;
    /**
     * Why it is being re-run, in the operator's words, kept as guidance.
     *
     * The channel a plain re-run had no way to offer. Everything a re-run reloads
     * comes from project config — `intent` from `harness.json` — so steering one
     * task meant editing the route every task shares, and the knowledge that
     * *this* attempt got it wrong reached the new session nowhere at all. Worse,
     * the session that diagnosed it was usually the correction being discarded, so
     * the diagnosis went out with the run. A cold re-run then reached the same
     * answer for the same reasons, which is the behaviour that makes re-running
     * look like it does nothing.
     *
     * Guidance rather than a field of its own, because guidance already is this:
     * cumulative, passed to every stage, and stated in the prompt to outrank the
     * brief. A second channel with the same meaning would be one the prompts do
     * not know how to rank against the first.
     */
    note?: string;
  },
): { pipeline: TaskPipeline; reopened: string[] } | undefined {
  const index = pipeline.stages.findIndex((s) => s.id === stageId);
  if (index === -1) return undefined;

  // Captured before the map below clears it. Only stages that actually ran: a
  // pending stage after the target is re-opened too, and recording a zero for it
  // would fill the ledger with entries for work that never happened.
  const discarded: DiscardedRun[] = discard
    ? pipeline.stages
        .slice(index)
        .filter((stage) => stage.subtasks.some((subtask) => subtask.startedAt))
        .map((stage) => {
          const totals = stageUsage(stage);
          return {
            stageId: stage.id,
            stageName: stage.name,
            at: discard.at,
            ...(discard.reason ? { reason: discard.reason } : {}),
            // Everything past the target went only because the target did.
            ...(stage.id === stageId ? {} : { collateral: true }),
            costUsd: totals.costUsd,
            tokens: totals.tokens,
            elapsedMs: totals.elapsedMs,
            sessions: totals.measured + totals.unmeasured,
          };
        })
    : [];

  const note = discard?.note?.trim();

  const reopened: string[] = [];
  const stages = pipeline.stages.map((stage, at) => {
    if (at < index) return stage;
    reopened.push(stage.id);
    return {
      ...stage,
      status: "pending" as const,
      startedAt: undefined,
      finishedAt: undefined,
      // Checklist items were raised by a run that is being discarded, so keeping
      // them would gate the task on evidence about work that no longer exists.
      checklist: undefined,
      // Same reasoning: a step marked done by the run being discarded would let the
      // re-run inherit credit for work that no longer exists, which is the exact
      // confusion per-step accounting exists to remove.
      planSteps: undefined,
      subtasks: stage.subtasks.map((subtask) => ({
        ...subtask,
        status: "pending" as const,
        startedAt: undefined,
        finishedAt: undefined,
        failureReason: undefined,
        sessionId: undefined,
        // What the discarded run said and did is dropped with it; a report showing
        // output from a run that was thrown away is worse than showing none.
        reply: undefined,
        activity: undefined,
      })),
    };
  });

  // The runs being discarded take their declines with them. Without this the items
  // only go dormant -- `outstandingDeferrals` hides them while the raising stage is
  // pending -- and return the moment it passes again, so a revert appeared to settle
  // nothing. Anything still true is raised afresh by the re-run.
  const withoutDiscardedDeferrals = discard
    ? settleDiscardedDeferrals(pipeline, reopened, discard.at)
    : pipeline;

  return {
    pipeline: {
      ...withoutDiscardedDeferrals,
      stages,
      currentStage: undefined,
      // A question or refusal belonged to the run being discarded.
      pendingQuestion: undefined,
      pendingDenials: undefined,
      // Appended, never replaced: the third time a stage is sent back, the first two
      // are the point.
      ...(discarded.length > 0
        ? { discarded: [...(pipeline.discarded ?? []), ...discarded] }
        : {}),
      // Attached to the stage being re-run, like a send-back's note, and appended
      // rather than replacing: a stage re-run three times accumulates three reasons,
      // and the earlier two are what stop the fourth attempt repeating them.
      ...(note
        ? {
            guidance: [
              ...(pipeline.guidance ?? []),
              {
                // Derived, not random, so the transition stays pure and a replay
                // produces the same pipeline.
                id: `rerun-${stageId}-${discard!.at}`,
                stageId,
                stageName: pipeline.stages[index].name,
                text: note,
                at: discard!.at,
                // The reason this stage is being redone, which stops meaning anything
                // once it has been. Delivered route-wide it outlived the run it
                // described: a re-run inherited a correction's bug report about the
                // build it was replacing and stopped to ask about an exception that no
                // longer existed.
                scope: "stage" as const,
              },
            ],
          }
        : {}),
    },
    reopened,
  };
}

/**
 * The guidance a given stage should actually be given.
 *
 * Everything used to reach every stage, which is right for an approval note and wrong
 * for the two kinds that arrived later. A send-back's findings and a re-run's reason
 * are about one stage's output; delivered to the whole route they become permanent,
 * outrank each later stage's brief, and describe work that has since been redone.
 *
 * Both failures happened on the same route in one morning. A DEV deployment preview was
 * handed three reviews' findings, already fixed two stages earlier, and spent part of
 * its report declining to re-litigate them. Then a re-run of an implementation stage was
 * handed a correction's finding about the build it had just replaced, and stopped to ask
 * three questions about an exception that no longer existed.
 *
 * A stage-scoped note is delivered only to the stage it names, and only while that stage
 * is unresolved: once it has passed, the note either worked or came back as a new
 * finding, and in neither case is it an instruction any more.
 *
 * The UI has always agreed with this — `stageReport` filters guidance to the stage it
 * was filed against — so what changed is that the runtime now matches what the report
 * claims a stage was told.
 */
export function guidanceFor(
  pipeline: TaskPipeline | undefined,
  stageId: string | undefined,
): string[] {
  const notes = pipeline?.guidance ?? [];
  if (!stageId) {
    // No stage in hand — a plain chat session rather than a stage run. Route-wide
    // notes only: a correction aimed at one stage has no meaning here.
    return notes.filter((note) => note.scope !== "stage").map((note) => note.text);
  }
  const stage = pipeline?.stages.find((s) => s.id === stageId);
  return notes
    .filter((note) => {
      if (note.scope !== "stage") return true;
      if (note.stageId !== stageId) return false;
      // A stage-scoped note that has already done its job. Kept on the pipeline for
      // the record and for the report; simply not handed to a session again.
      return stage?.status !== "passed" && stage?.status !== "skipped";
    })
    .map((note) => note.text);
}

/**
 * Moves rule-added reviews that have not run yet back in front of the barrier.
 *
 * A repair, for tasks whose reviews were spliced by an earlier build that placed
 * them before the first human gate — which in a route that deploys to dev before
 * signing off meant *after* the deployment. A pipeline is a snapshot, so fixing
 * the splice rule fixed new tasks and left existing ones with a SQL review
 * scheduled after the SQL had been deployed.
 *
 * Only **pending** rule stages move. A review that has already run stays where it
 * ran: re-ordering history to match the current rule would misreport what actually
 * happened, which is worse than an out-of-date order.
 */
export function repositionRuleStages(
  pipeline: TaskPipeline,
  insertionIndex: (stages: readonly TaskStage[], kind?: StageKind) => number,
): { pipeline: TaskPipeline; moved: string[] } {
  // Each stage judged against its own target, not one shared barrier: a static review
  // belongs in front of the deployment and a behaviour review that writes a checklist
  // belongs after it, so "is it in the wrong place?" is a different question per kind.
  const movable = pipeline.stages.filter(
    (stage, index) =>
      stage.addedByRule !== undefined &&
      stage.status === "pending" &&
      index !== insertionIndex(pipeline.stages, stage.kind),
  );
  if (movable.length === 0) return { pipeline, moved: [] };

  const rest = pipeline.stages.filter((stage) => !movable.includes(stage));
  const stages = [...rest];
  const moved: string[] = [];
  for (const stage of movable) {
    // Recomputed as each one lands: removing the movable stages shifts the barrier,
    // and every insertion shifts it again.
    const target = insertionIndex(stages, stage.kind);
    // A stage already where it belongs relative to the others is left alone rather
    // than reported as moved — the caller announces the move to the user.
    const from = pipeline.stages.indexOf(stage);
    stages.splice(target, 0, stage);
    if (stages.indexOf(stage) !== from) moved.push(stage.id);
  }

  if (moved.length === 0) return { pipeline, moved: [] };
  return { pipeline: { ...pipeline, stages }, moved };
}

/**
 * Stages a given stage's findings may be sent back to, nearest first.
 *
 * Only what the stage declares in `sendBackTo`, so an undeclared stage offers
 * nothing. Restrictive by default and deliberately so: a planning stage that
 * could send work back to planning would plan forever, and the route is the only
 * thing that knows which loops are the useful ones.
 */
export function sendBackTargets(
  pipeline: TaskPipeline,
  fromStageId: string,
): TaskStage[] {
  const index = pipeline.stages.findIndex((s) => s.id === fromStageId);
  if (index <= 0) return [];

  const allowed = pipeline.stages[index].sendBackTo ?? [];
  if (allowed.length === 0) return [];

  const kinds = allowed
    .map((entry) => sendBackEntryKind(entry))
    .filter((kind): kind is StageKind => kind !== undefined);

  // Reversed: the stage that produced the work under review is the likely target,
  // and it is the one immediately before, not the start of the route. Only earlier
  // stages are ever considered, which is what keeps a kind entry as safe as an id.
  const nearestFirst = pipeline.stages
    .slice(0, index)
    .filter((stage) => allowed.includes(stage.id) || kinds.includes(stage.kind))
    .reverse();

  // Then: a stage that can change the work outranks one that only decides what
  // should be done, however near it is. A route that plans a deployment *after*
  // implementing puts a planning stage immediately before the review, so proximity
  // recommended sending a critical finding about a stored procedure to a stage that
  // cannot touch one — and the caller offering the list takes the first as its
  // recommendation.
  //
  // Planning is kept in the list, and ordering is the whole of the fix: sending
  // findings to planning is a real move — a review that says an object is in the
  // wrong layer has found a planning error — but it re-opens everything after
  // planning, so it must be chosen by name rather than arrived at by default.
  return [
    ...nearestFirst.filter((stage) => stage.kind !== "planning"),
    ...nearestFirst.filter((stage) => stage.kind === "planning"),
  ];
}

/**
 * Sends work back to an earlier stage, carrying the findings that justify it.
 *
 * The gap this fills: a review stage reports a critical problem and several
 * lesser ones, and the only way back to implementation was `revertToStage` —
 * which discards the reviewing stage's reply along with everything after the
 * target. So the act of sending work back destroyed the reason for sending it,
 * and the findings had to be copied out by hand first or retyped from memory.
 *
 * Guidance is the carrier. It survives a revert, and every subsequent stage
 * prompt is given all of it, so the re-opened stage reads the findings as
 * instructions without the review's own output needing to be preserved.
 */
export function sendBackToStage(
  pipeline: TaskPipeline,
  input: {
    targetStageId: string;
    /** The stage whose findings these are; must be later than the target. */
    fromStageId: string;
    /** The findings themselves, usually the reviewing stage's reply. */
    findings: string;
    /** Anything the operator wants to add to them. */
    note?: string;
    at: string;
  },
): { pipeline: TaskPipeline; reopened: string[]; note: string } | undefined {
  const targetIndex = pipeline.stages.findIndex((s) => s.id === input.targetStageId);
  const fromIndex = pipeline.stages.findIndex((s) => s.id === input.fromStageId);
  if (targetIndex === -1 || fromIndex === -1) return undefined;
  // Strictly backwards. Sending a stage's findings to itself would discard them
  // as it re-ran, and "back" to a later stage is not a thing this can mean.
  if (targetIndex >= fromIndex) return undefined;
  // Checked here as well as when offering the choice: this is the transition that
  // reshapes the pipeline, and a target the route never sanctioned must not become
  // reachable through a stale menu, a headless caller or a hand-edited state file.
  if (!sendBackTargets(pipeline, input.fromStageId).some((s) => s.id === input.targetStageId)) {
    return undefined;
  }

  const from = pipeline.stages[fromIndex];
  const target = pipeline.stages[targetIndex];
  const text = formatSendBackNote(from.name, input.findings, input.note);

  // Named by the stage that sent it back, because that is the question the ledger
  // has to answer: which reviews are costing the route re-runs, and how much.
  const reverted = revertToStage(pipeline, input.targetStageId, {
    at: input.at,
    reason: `sent back from "${from.name}"`,
  });
  if (!reverted) return undefined;

  return {
    pipeline: {
      ...reverted.pipeline,
      // Attached to the target, not to the stage that raised it: the reviewing
      // stage is about to be re-opened and re-run, and a note filed under it would
      // read as guidance for the review rather than for the work being redone.
      guidance: [
        ...(reverted.pipeline.guidance ?? []),
        {
          // Derived from the stages and the timestamp rather than random, so the
          // transition stays pure and a replay produces the same pipeline.
          id: `sendback-${from.id}-${target.id}-${input.at}`,
          stageId: target.id,
          stageName: target.name,
          text,
          at: input.at,
          // For the stage being redone, not for the route. These are findings about
          // one stage's output: once it has been redone they are answered, and a
          // deployment preview four stages later reading them as live instructions
          // is how one stage spent its report declining to re-litigate them.
          scope: "stage" as const,
        },
      ],
    },
    reopened: reverted.reopened,
    note: text,
  };
}

/**
 * The guidance note a send-back leaves behind.
 *
 * Names the stage that raised the findings, because by the time the re-opened
 * stage reads this that stage's own output has been discarded — without the
 * attribution the findings would arrive from nowhere.
 */
export function formatSendBackNote(
  fromStageName: string,
  findings: string,
  note?: string,
): string {
  const parts = [
    `Sent back from "${fromStageName}". Address these findings, and say what you changed for each:`,
    findings.trim(),
  ];
  if (note?.trim()) parts.push(`Also, from the operator: ${note.trim()}`);
  return parts.join("\n\n");
}

function findDefinition(
  source: StageDefinitionSource,
  routeId: string,
  stage: Pick<TaskStage, "id" | "addedByRule">,
):
  | {
      intent?: string;
      model?: string;
      handoff?: boolean;
      verify?: string;
      planFile?: string;
      requiredMcpServers?: readonly string[];
      // Only a route stage declares these; a rule stage has neither, and `undefined`
      // from a rule is the right answer rather than a missing property.
      checklistScope?: string;
      checklistAudience?: ChecklistAudience;
    }
  | undefined {
  if (stage.addedByRule) {
    return source.rules.find((rule) => rule.stage.id === stage.id)?.stage;
  }
  const route = source.routes.find((r) => r.id === routeId);
  return route?.stages.find((s) => s.id === stage.id);
}

/** Order-insensitive: a reordered list of required servers is the same requirement. */
function sameNames(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = [...(a ?? [])].map((n) => n.trim()).filter(Boolean).sort();
  const right = [...(b ?? [])].map((n) => n.trim()).filter(Boolean).sort();
  return left.length === right.length && left.every((name, at) => name === right[at]);
}

/** Blank and absent mean the same thing in config, so compare them that way. */
function normalize(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Brings a pipeline's handoff flags in line with config, and backfills the
 * conclusions of stages that have already run.
 *
 * Needed because `handoff` is snapshotted onto a stage at creation, like every
 * other stage field — so a task created before the field existed would never
 * carry anything forward, and the answer would be "recreate your task", which
 * throws away everything already approved.
 *
 * Two halves, and the second is the one that matters. Setting the flag is safe on
 * a stage of any status: unlike `intent`, it is not a record of what the stage ran
 * with, it is a switch deciding whether its conclusion travels. And a stage that
 * has already passed still has its reply persisted, so its conclusion can be
 * recorded now rather than lost for want of a flag that did not exist when it ran.
 *
 * `splittable` is still excluded from all of this, for the reason it always was:
 * it decides how many subtasks a stage has, so changing it reshapes a pipeline
 * mid-flight.
 */
export function syncHandoffs(
  pipeline: TaskPipeline,
  source: StageDefinitionSource,
  at: string,
): { pipeline: TaskPipeline; enabled: string[]; backfilled: string[] } {
  const enabled: string[] = [];
  const backfilled: string[] = [];
  // Tracked separately from `enabled`, because turning a flag *off* is also a
  // change: keying the early return on `enabled` alone silently discarded it and
  // the pipeline came back with the flag still set.
  const disabled: string[] = [];

  const stages = pipeline.stages.map((stage) => {
    const definition = findDefinition(source, pipeline.routeId, stage);
    if (!definition) return stage;
    const desired = definition.handoff === true;
    if (desired === (stage.handoff === true)) return stage;
    if (desired) {
      enabled.push(stage.id);
      return { ...stage, handoff: true };
    }
    disabled.push(stage.id);
    return { ...stage, handoff: undefined };
  });

  const handoffs = [...(pipeline.handoffs ?? [])];
  for (const stage of stages) {
    if (!stage.handoff || stage.status !== "passed") continue;
    if (handoffs.some((handoff) => handoff.stageId === stage.id)) continue;
    // The last subtask's reply is the stage's conclusion: a split stage's earlier
    // subtasks are steps towards it, and the final one is where it lands.
    const reply = [...stage.subtasks].reverse().find((subtask) => subtask.reply?.trim())?.reply;
    if (!reply) continue;
    handoffs.push({
      stageId: stage.id,
      stageName: stage.name,
      text: truncateHandoff(reply),
      at,
    });
    backfilled.push(stage.id);
  }

  if (enabled.length === 0 && backfilled.length === 0 && disabled.length === 0) {
    return { pipeline, enabled, backfilled };
  }
  return {
    pipeline: {
      ...pipeline,
      stages,
      ...(handoffs.length > 0 ? { handoffs } : {}),
    },
    enabled,
    backfilled,
  };
}
