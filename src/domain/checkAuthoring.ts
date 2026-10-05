import type { TaskPipeline } from "./taskPipeline";
import { coverageForGate } from "./checkCoverage";

/**
 * Whether a gate asked to express its checklist as checks actually tried.
 *
 * `checkCoverage` states the rule this refines: *a gap is counted and named, never
 * blocking*, because holding on gaps alone would hold every gate of every route and
 * that is how a signal gets switched off. The rule is right and it left a hole. A
 * gate's intent can ask, at length, for each item to be written as a check and for a
 * real failure message rather than a guess before declaring one inexpressible -- and
 * nothing read whether it had. The gate settled, the operator was asked to click the
 * items by hand, and the stage's own account of why was prose.
 *
 * Measured, which is why this exists rather than another paragraph of intent: a
 * re-run of a check-writing gate that *had* received the corrected intent ran the four
 * checks that already existed, opened neither the manifest nor the tool's own
 * documentation, wrote "I changed no files", and left three items untagged with the
 * reason "not tried". Fourteenth instance of the reply-claims-an-outcome-the-parser-
 * cannot-check disease, and the parser can check this one.
 *
 * `pathsWritten` cannot carry it. `wroteOutsideTheWriteTools` treats a session that
 * used Bash or PowerShell as **unmeasured, not zero**, which is right -- and that gate
 * used both, so the honest measure would correctly abstain exactly where it is needed.
 * The manifest file itself is the artefact the stage owes, so it is what is sampled:
 * the pattern `humanWaitMs` and the worktree list already use, one file along.
 *
 * Pure and vscode-free.
 */

/** The manifest as it stood either side of a session. `undefined` is unreadable or absent. */
export interface ManifestSample {
  before: string | undefined;
  after: string | undefined;
}

export const CHECK_AUTHORING_REASON =
  "This gate declares a check manifest and left checklist items with no check " +
  "attached, and the manifest is byte-for-byte what it was before the session -- so " +
  "nothing was authored. Either a check can express each item, or a real failure " +
  "message says why it cannot; neither was produced.\n\n" +
  "Correct this stage rather than re-running it: a correction keeps everything it " +
  "produced, and may attach a check it writes and runs to the item that check " +
  "answers. Approve it instead if the gaps are genuinely inexpressible.";

/**
 * The reason to hold a settled check-writing gate, or `undefined` to leave it alone.
 *
 * Narrow in five ways, each load-bearing:
 *
 * - **Declared, never inferred from the kind.** Which gates are expected to author
 *   checks is a property only the project knows -- an acceptance gate on a deployed
 *   site may have nothing a local suite can reach. Absence of `checkManifest` means
 *   unchanged, so nothing that has not opted in is affected.
 * - **Unchecked gaps only.** A ticked item was answered by a person, and holding
 *   because the operator had already done the work by hand would be perverse. It also
 *   keeps this from firing on a gate whose items a later pass ticks.
 * - **Both readings must exist, and differ.** A manifest absent before *and* after is
 *   indistinguishable from a path nobody typed correctly, and that misconfiguration
 *   would hold every gate of every route -- the exact failure the rule above warns of.
 *   Absence of measurement is not permission to act. A manifest that appeared during
 *   the session is an attempt, whatever else is true of it.
 * - **Held, never failed.** "No check can express this" is a legitimate outcome, and
 *   the operator can see the items and the suite. Holding costs a click; failing costs
 *   a stage whose only remedy discards it.
 * - **Never on a repair round.** A correction is handed one finding and told to make
 *   the smallest change that answers it, so holding it against the whole checklist
 *   would be judging it by a brief it was not given -- and `correctionChangedNothing`
 *   already covers a correction that did nothing. A correction *may* now attach a
 *   check it wrote (`coverageFromCorrection`), which is what makes the repair for this
 *   hold the cheap one. The caller supplies the fact that this is a repair round.
 */
export function checkAuthoringSkipped(
  pipeline: TaskPipeline,
  stageId: string,
  sample: ManifestSample,
): string | undefined {
  const gate = pipeline.stages.find((stage) => stage.id === stageId);
  if (!gate?.checkManifest) return undefined;

  if (sample.before === undefined || sample.after === undefined) return undefined;
  if (sample.before !== sample.after) return undefined;

  const gaps = coverageForGate(pipeline, stageId).filter(
    (entry) => entry.state === "gap" && !entry.item.checked,
  );
  if (gaps.length === 0) return undefined;

  return CHECK_AUTHORING_REASON;
}
