/**
 * What a stage is told when the stage it was built on has just been corrected.
 *
 * The saving this exists for, measured over 2.5 hours on 17 Aug 2026: **$97.34
 * spent, $59.10 of it discarded — 61%** — and every penny of that came from three
 * corrections re-opening the stages behind them. 35 stage re-runs from three
 * findings.
 *
 * The work itself was not wasted; those stages genuinely had to respond to a
 * changed plan. What was wasted is that each of them started **cold**. `reopenAfter`
 * cleared `reply` and `activity`, so a stage absorbing "the comparison dropdown is
 * now two dropdowns" re-read the ticket, re-derived the codebase and re-decided its
 * approach from nothing. The repeats prove there is no learning curve: one task's
 * `Implement the data` was discarded six times at $1.50, $4.33, $9.41, $3.13, $2.51
 * and $10.94 — every attempt paying full price.
 *
 * The harness already had the cheaper mechanism and was applying it one stage too
 * narrowly. `correctStage` exists because a cold re-run cost "$12.48 and 44 minutes
 * and 15M cached tokens to change a type", and it fixes that by handing the session
 * its own previous report. That saving reached only the stage the operator
 * corrected; every stage behind it was reverted. This applies the same argument one
 * level out: a downstream stage is *amended*, not rebuilt.
 *
 * What does **not** change, and must not: nothing is skipped, and no stage is left
 * recorded as passed against output that moved underneath it. Every stage that ran
 * before still runs again. The difference is only that it starts from what it
 * already knew.
 */

/** The correction that caused an amendment, so it can be explained and undone. */
export interface UpstreamCorrection {
  stageId: string;
  stageName: string;
  /** What the operator said was wrong with that stage. */
  finding: string;
}

/**
 * The brief for a stage whose input has just changed.
 *
 * Deliberately narrowing, for the same reason `correctionPrompt` is. Left to
 * itself a capable model treats "this changed upstream" as licence to revisit its
 * whole output, which costs exactly what the cold re-run cost and additionally
 * invalidates the reviews that had already passed the rest of it.
 *
 * Returned as the *finding* of a correction subtask rather than as a finished
 * prompt, so `correctionPrompt` wraps it exactly as it wraps an operator's own
 * finding. That is what keeps the decline marker out of this module: the escape
 * hatch for a change too large to amend is already stated there, and stating it
 * twice is how the two come to disagree. It also keeps the layering honest — the
 * marker belongs to the execution adapter, and the domain has no business naming it.
 *
 * `earlier` carries the findings of amendments this one absorbed — corrections of the
 * same upstream stage that were appended and never ran. They are stated in the order
 * they happened and in one note, because that is what the stage is actually facing:
 * one base output and several deltas against it. Delivered as separate subtasks they
 * cost a session each to re-read the same output, which is the accumulation that hit
 * the step limit on a 29-stage route — 69 never-run amendments across eight stages.
 */
export function upstreamAmendmentNote(
  upstream: UpstreamCorrection,
  earlier: string[] = [],
): string {
  const changes = [...earlier, upstream.finding]
    .map((finding) => finding.trim())
    .filter((finding) => finding.length > 0);
  const many = changes.length > 1;
  // The one-change wording is left exactly as it was rather than generalised, so a
  // single amendment — still the common case — reads and renders identically to
  // before this could absorb anything.
  return [
    ...(many
      ? [
          `"${upstream.stageName}" was corrected ${changes.length} times after you ran, so`,
          `the work above was produced against a version of it that no longer stands.`,
          "",
          `What changed there, in the order it changed:`,
          ...changes
            .flatMap((change, i) => [`(${i + 1} of ${changes.length})`, change, ""])
            .slice(0, -1),
          "",
          `Your previous output is above. Bring it into line with those changes and`,
          `nothing else — the rest of what you did still stands, and rewriting it costs`,
          `the route the whole run this exists to avoid, as well as invalidating the`,
          `reviews that already passed it. Say what you changed and what you`,
          `deliberately left alone.`,
        ]
      : [
          `"${upstream.stageName}" was corrected after you ran, so the work above was`,
          `produced against a version of it that no longer stands.`,
          "",
          `What changed there:`,
          changes[0] ?? "",
          "",
          `Your previous output is above. Bring it into line with that change and nothing`,
          `else — the rest of what you did still stands, and rewriting it costs the route`,
          `the whole run this exists to avoid, as well as invalidating the reviews that`,
          `already passed it. Say what you changed and what you deliberately left alone.`,
        ]),
    "",
    `If the change is large enough that amending cannot reach a correct result — a`,
    `different approach is now required, not a different detail — do not half-apply`,
    `it: decline, as described above. That is a rebuild, and only a human may choose`,
    `one.`,
  ].join("\n");
}

/**
 * The title an amendment subtask carries.
 *
 * Names the upstream stage rather than numbering, because the two kinds of repeat
 * mean opposite things and a reader has to tell them apart: "Correction 3" is a
 * stage that got its own work wrong three times, where three amendments is a stage
 * that was right each time and had the ground moved under it. Conflating them would
 * point the next investigation at exactly the wrong stage.
 */
export function amendmentTitle(upstreamStageName: string, ordinal: number): string {
  return ordinal > 1
    ? `Amend for "${upstreamStageName}" (${ordinal})`
    : `Amend for "${upstreamStageName}"`;
}
