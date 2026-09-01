import { markerLine, markerText } from "./replyMarkers";
import { sendBackEntryKind } from "./taskRoute";
import { TaskPipeline, TaskStage } from "./taskPipeline";

/**
 * A review naming the stage that should fix what it found.
 *
 * The other half of adaptive execution, and the narrower half. `stageAuthority` lets a
 * route continue when nothing is wrong; this lets it continue when something is, by
 * turning a finding into repair work instead of into an operator's afternoon.
 *
 * Measured 1 Sep 2026 across 17 pipelines: **205 of 353 discard entries — $394 of the
 * $570 discarded — are "re-run by hand"**, and 19 of the 68 guidance notes are the
 * send-back text `formatSendBackNote` composes. The operator wrote none of those 19: a
 * review found something, and their entire contribution was choosing a target and
 * clicking. The objective already implied the findings had to be fixed.
 *
 * ## Why the review proposes the target, and the harness does not derive it
 *
 * Deriving it was measured and rejected. `sendBackTargets` orders candidates
 * nearest-first with planning last, and the caller takes the first as its
 * recommendation; run against all 19 historical send-backs it agreed with the operator
 * **11 times and disagreed 7**. The misses are systematic — the operator chose
 * *planning* where proximity chose implementation — and sending findings to planning
 * re-opens everything after it. At 58% an automatic route would mis-invalidate a
 * pipeline about two times in five.
 *
 * The judgement that ordering cannot reach is available to the reviewer and to nobody
 * else: it wrote the findings, it knows which name a stored procedure and which name a
 * layering decision. That is the division the whole runtime rests on — the model owns
 * judgement, the harness owns authority — so the reviewer proposes a target by name and
 * this module decides whether the proposal is legal.
 *
 * ## What makes a proposal legal
 *
 * Only what the route already declared. Nothing here is a new permission surface:
 *
 * - **`sendBackTo` is the authority**, unchanged. It is the existing declaration of
 *   which stages a review may reach, it is repository-owned config, and a proposal
 *   outside it is refused rather than negotiated. A review that declares nothing can
 *   propose nothing, which is the absence-means-unchanged rule.
 * - **Earlier in the route, always.** A repair that reaches forward is not a repair.
 * - **The target must have produced something.** `correctStage` works by handing the
 *   session its own previous report, so a stage that wrote nothing gives it nothing to
 *   start from — the argument `sendBackTargets` already makes, and the failure it was
 *   patched for on NMGB-2814, where a stage with zero files across twelve subtasks was
 *   the recommended target.
 * - **It adds work, never removes assurance.** A proposal can only ever append a
 *   correction subtask. There is no vocabulary here for skipping a review, passing a
 *   gate or dropping a stage, because the risk asymmetry is not close: more assurance
 *   costs a session, less costs the thing the route existed to protect.
 *
 * The repair itself is `correctStage` — existing machinery, with existing invalidation.
 * Downstream stages are amended rather than rebuilt by `upstreamAmendment`, amendments
 * of one stage coalesce, and withdrawing restores. Nothing new decides what becomes
 * stale, which is the point: this module chooses a target and nothing else.
 */

/**
 * The marker a review uses to propose a repair.
 *
 * A separate marker from `DEFERRED` and `BLOCKED` because the remedy differs and the
 * remedy is what a marker is for. `DEFERRED` says no stage owns this; `BLOCKED` says a
 * prerequisite is missing; this says a named earlier stage owns it and can fix it now.
 */
export const REPAIR_MARKER = "REPAIR";

const REPAIR_RE = new RegExp(markerLine(`${REPAIR_MARKER}:`), "gim");

export interface RepairProposal {
  /** The stage the review says should fix this, as it spelled it. */
  target: string;
  /** What to fix, in the reviewer's words. Handed to `correctStage` as the finding. */
  finding: string;
}

/** Why a proposal was refused, or the stage it resolved to. */
export type RepairAdjudication =
  | { admissible: true; stage: TaskStage; finding: string }
  | { admissible: false; reason: string };

/**
 * Reads `REPAIR: <stage> — <what to fix>` lines out of a reply.
 *
 * Tolerant about the separator because a model writes an em-dash, an en-dash, a hyphen
 * or a colon and all four mean the same thing here. Strict about the rest: the stage
 * name comes first, so a line that is all prose yields no target and is dropped rather
 * than guessed at.
 */
export function parseRepairProposals(reply: string | undefined): RepairProposal[] {
  if (!reply) return [];
  const found: RepairProposal[] = [];
  for (const match of reply.matchAll(REPAIR_RE)) {
    const text = markerText(match[1], match[0]);
    const split = /^(.+?)\s*(?:—|–|-{1,2}|:)\s+(.*)$/.exec(text);
    if (!split) continue;
    const target = split[1].trim();
    const finding = split[2].trim();
    if (!target || !finding) continue;
    found.push({ target, finding });
  }
  return found;
}

/**
 * Decides whether a proposed repair may be applied, and to which stage.
 *
 * Every refusal is a refusal to act, never a refusal to record: the caller holds the
 * stage and shows the reason, so a proposal the harness would not apply still reaches
 * the operator as a recommendation with a named target. That is strictly better than
 * what a review could say before, which was prose in a report nobody routed.
 *
 * Matched by id first and then by exact label, because a reviewer is far likelier to
 * write the name it was shown in `routeStages` than the id. Deliberately **not** fuzzy:
 * a near-match that picks the wrong stage re-opens work that was correct, and the
 * failure `deferralKey` refuses to risk is the same one here. An unmatched name is
 * refused, and refusing costs a click.
 */
export function adjudicateRepair(
  pipeline: TaskPipeline,
  fromStageId: string,
  proposal: RepairProposal,
): RepairAdjudication {
  const index = pipeline.stages.findIndex((s) => s.id === fromStageId);
  if (index <= 0) return no("the review is not a stage that anything precedes");

  const allowed = pipeline.stages[index].sendBackTo ?? [];
  if (allowed.length === 0) {
    return no("this review declares no stages it may send findings back to");
  }
  const kinds = allowed
    .map((entry) => sendBackEntryKind(entry))
    .filter((kind): kind is NonNullable<ReturnType<typeof sendBackEntryKind>> => kind !== undefined);

  const wanted = proposal.target.trim().toLowerCase();
  const earlier = pipeline.stages.slice(0, index);
  const target = earlier.find(
    (s) => s.id.toLowerCase() === wanted || s.name.trim().toLowerCase() === wanted,
  );
  if (!target) {
    // Names a later stage, or none at all. Reported apart from the authority refusal
    // below because the operator's next move differs: one is a review reaching forward,
    // the other a route that never permitted the reach.
    const later = pipeline.stages
      .slice(index)
      .find((s) => s.id.toLowerCase() === wanted || s.name.trim().toLowerCase() === wanted);
    return no(
      later
        ? `"${later.name}" comes after this review, and a repair cannot reach forward`
        : `no stage before this review is called "${proposal.target}"`,
    );
  }

  if (!allowed.includes(target.id) && !kinds.includes(target.kind)) {
    return no(`this review may not send findings back to "${target.name}"`);
  }

  // The productivity test `sendBackTargets` applies to ordering, applied here as a
  // refusal. A correction is handed the stage's own previous output; there is nothing
  // to hand a stage that produced none, so the session would start cold and the saving
  // that makes an automatic repair worth doing is gone.
  if (!producedSomething(target)) {
    return no(`"${target.name}" has produced nothing to correct`);
  }

  return { admissible: true, stage: target, finding: proposal.finding };
}

/**
 * Whether a stage left anything a correction could be handed.
 *
 * A reply is enough, not only written files: a planning stage's output is its plan and
 * a deployment preview's is its report, and requiring `pathsWritten` would refuse a
 * repair to exactly the stages whose product is prose. What this excludes is the stage
 * that never ran, or whose run an earlier revert discarded.
 */
function producedSomething(stage: TaskStage): boolean {
  return stage.subtasks.some((s) => s.reply?.trim() || s.activity?.pathsWritten?.length);
}

function no(reason: string): RepairAdjudication {
  return { admissible: false, reason };
}
