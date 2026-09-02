/**
 * Whether a stage declined work that its own route already owns.
 *
 * `DEFERRED` means work **no stage owns** — that is what the engine has always meant by
 * it, what makes the hold in front of a deployment worth stopping for, and what the
 * prompt and the protocol skill both say. A stage that can name the owning stage is
 * told to say so in its report and move on.
 *
 * The instruction was in the prompt and nowhere else, so nothing checked it. A DEV
 * preview stage declined "actually deploying these 3 files to DEV" and named the
 * `Deploy to DEV` stage in the same sentence — work the route owns, two rows below, in
 * a stage the pipeline lists as pending. Settling it asked a human to write a sentence
 * about who owns work whose owner was quoted in the item. One real task reached 40
 * declined items, 27 of them four observations reworded by each stage that noticed
 * them, nearly all naming the stage that already owned them.
 *
 * This is the parser enforcing a rule the prompt states, which is the only arrangement
 * that has ever held: a stage has `routeStages` and knows the answer, and the pipeline
 * can check it deterministically because it knows every stage's name and status.
 *
 * Pure and vscode-free.
 */

import { TaskPipeline, TaskStage } from "./taskPipeline";

/** Statuses meaning the stage has not run yet, so naming it is a claim about the future. */
const UNRESOLVED = new Set<TaskStage["status"]>(["pending", "active", "awaiting-approval"]);

/**
 * The stage a declined item names as its owner, if it names one.
 *
 * Deliberately narrow, because the two errors are not equal. Auto-settling a real
 * ownerless item is the failure this whole mechanism exists to prevent — it is how a
 * live publish halted on a data structure nobody had created. Leaving a redundant item
 * to be settled by hand costs a sentence. So a bare mention of a stage name is not
 * enough: a deferral reading "implement the staging table" must not match a stage called
 * "Implement".
 *
 * The mention has to *look like a reference to a stage*, which in practice means the
 * name is quoted, or the word "stage" sits beside it — which is exactly how the stages
 * that do this write it, because `routeStages` gives them the names and the prompt calls
 * them stages.
 */
export function ownedByPendingStage(
  text: string,
  pipeline: TaskPipeline,
  raisedByStage: string,
): TaskStage | undefined {
  const haystack = text.toLowerCase();

  for (const stage of pipeline.stages) {
    // Its own stage is not an owner: a stage naming itself is describing what it did
    // not do, which is a refusal, not a handover.
    if (stage.id === raisedByStage) continue;
    if (!UNRESOLVED.has(stage.status)) continue;

    if (citesStageByName(haystack, stage.name)) return stage;
  }
  return undefined;
}

/**
 * Whether a stage's own name is cited *as a stage* anywhere in this text.
 *
 * Shared with `namedByFindings`, which asks the same question of a review's blocking
 * findings in order to recommend a send-back target. It read only the double-quoted
 * spelling, and no prompt has ever asked for one: `deferralInstruction` says "say so in
 * your report, in a sentence" and specifies no form. So a review naming an owner in the
 * obvious English — `a plan and data-stage decision, not a review fix` — matched
 * nothing, and the recommendation fell back to proximity and offered the stage that had
 * just been corrected instead of the one the finding named.
 *
 * The narrowness is `ownedByPendingStage`'s, unchanged and for its reasons: the whole
 * name, and cited rather than merely mentioned. Deliberately **not** widened to match
 * part of a name — "the data stage" against `Implement the data` — because a near-match
 * that picks the wrong stage re-opens correct work, which is the failure both callers
 * exist to prevent. The prompt now asks for the name it already has from `routeStages`,
 * which is the half of this that makes the English form reachable at all.
 *
 * `text` is expected already lower-cased by the caller, since both callers loop over
 * every stage against one body of prose.
 */
export function citesStageByName(text: string, stageName: string): boolean {
  const name = stageName.trim().toLowerCase();
  // A name too short to be distinctive would match half the prose in a report.
  if (name.length < 4) return false;

  let from = text.indexOf(name);
  while (from !== -1) {
    if (referencesAStage(text, from, name.length)) return true;
    from = text.indexOf(name, from + 1);
  }
  return false;
}

/**
 * Whether the name at this position is being cited as a stage.
 *
 * Two spellings, both taken from real replies: `the "Deploy to DEV" stage`, and
 * `the promote stage does it`. The window is small on purpose — "the deployment will
 * need a stage table" must not read as a citation.
 */
function referencesAStage(text: string, at: number, length: number): boolean {
  const before = text.slice(Math.max(0, at - 12), at);
  const after = text.slice(at + length, at + length + 12);

  if (/\bstage\b/.test(after) || /\bstage\b/.test(before)) return true;
  // Quoted, which is a citation whether or not the word "stage" is present.
  const quoteBefore = /["'“‘`]\s*$/.test(before);
  const quoteAfter = /^\s*["'”’`]/.test(after);
  return quoteBefore && quoteAfter;
}

/** How a settled-on-sight item explains itself in the report. */
export function ownedByStageResolution(stage: TaskStage): string {
  return `The route's "${stage.name}" stage owns this; it has not run yet.`;
}
