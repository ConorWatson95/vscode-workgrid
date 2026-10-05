import type { TaskPipeline } from "./taskPipeline";
import { outcomesOf, splitCheckTag } from "./checkCoverage";

/**
 * Checks a *correction* wrote, and which checklist item each one answers.
 *
 * The hole this closes is one made four days earlier, and made deliberately. A
 * correction's reply is not run through `parseChecklistReply`, because
 * `recordChecklist` **replaces** the list and would destroy the ticks the gate's own
 * checks had just earned. That rule is right and it took the whole of check coverage
 * with it: a correction could author a check, run it, and have no way on earth to say
 * which item it answered -- so the only remedy for a gate that left items untagged was
 * a full re-run, cold, of a stage whose output was otherwise fine.
 *
 * Measured, which is why this exists: the Pyramid export gate was re-run twice against
 * a corrected intent. Both runs tagged four of eight items, declined the rest, and the
 * second declined two of them as tooling limits the suite's own documentation refutes
 * -- a document it never opened. A re-run starts cold and reaches the same answer for
 * the same reasons, which is `correctStage`'s founding argument; it simply could not be
 * applied here.
 *
 * Additive by construction. `setItemCoverage` attaches a check to an item without
 * touching the list, and never ticks -- whether the item is now answered stays
 * `tickAnsweredItems`' question, decided from the run rather than from the reply.
 *
 * Pure and vscode-free.
 */

export interface CoverageClaim {
  itemId: string;
  coveredBy: string;
  /** The item's text, for the step the caller announces. */
  itemText: string;
}

export interface CorrectionCoverage {
  claims: CoverageClaim[];
  /**
   * Tagged lines that answered nothing, with why.
   *
   * Announced rather than dropped: a correction that wrote a check and had the claim
   * ignored looks exactly like one that wrote no check, and the operator would go
   * looking for the wrong thing. The rule a discarded file already follows.
   */
  ignored: { line: string; why: "no such item" | "no such check" | "already covered" }[];
}

/** One string, whitespace and case folded. Not a fuzzy match: the same text, retyped. */
function fold(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The coverage a correction's reply claims, matched against what actually exists.
 *
 * Four guards, each load-bearing:
 *
 * - **The check must have run.** Matched against `checkOutcomes`, which by this point
 *   hold *this* advance's run -- `runVerification` executes before the reply is parsed.
 *   So a check written and never run attaches to nothing, which is the rule the gate's
 *   own intent states and the one thing the harness can enforce rather than ask for.
 * - **The item must exist, matched exactly.** Folded for whitespace and case, because
 *   the session is retyping a line from its own previous report, and never further:
 *   fuzzy matching is what `sendBackTargets` and `namedByFindings` both refuse, and a
 *   claim attached to the wrong item is a false statement about what was verified.
 * - **An item that already names a check is left alone.** Re-attributing an item is the
 *   operator's command, not a correction's: the existing id may be the one a tick was
 *   granted on.
 * - **Nothing is ticked here.** Attaching and settling are two acts, which is what lets
 *   this run on a check whose outcome is already recorded and on one whose is not.
 */
export function coverageFromCorrection(
  pipeline: TaskPipeline,
  stageId: string,
  reply: string,
): CorrectionCoverage {
  const gate = pipeline.stages.find((stage) => stage.id === stageId);
  const claims: CoverageClaim[] = [];
  const ignored: CorrectionCoverage["ignored"] = [];
  if (!gate?.checklist?.length) return { claims, ignored };

  const ran = new Set(outcomesOf(gate).map((outcome) => fold(outcome.id)));
  const taken = new Set<string>();

  for (const raw of reply.split("\n")) {
    const line = raw.replace(/^\s*[-*]\s*/, "").trim();
    if (!line) continue;
    const { text, coveredBy } = splitCheckTag(line);
    if (!coveredBy || !text) continue;

    if (!ran.has(fold(coveredBy))) {
      ignored.push({ line, why: "no such check" });
      continue;
    }
    const item = gate.checklist.find((candidate) => fold(candidate.text) === fold(text));
    if (!item) {
      ignored.push({ line, why: "no such item" });
      continue;
    }
    if (item.coveredBy || taken.has(item.id)) {
      ignored.push({ line, why: "already covered" });
      continue;
    }
    taken.add(item.id);
    claims.push({ itemId: item.id, coveredBy: coveredBy.trim(), itemText: item.text });
  }

  return { claims, ignored };
}
