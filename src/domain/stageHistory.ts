import { Subtask, TaskStage } from "./taskPipeline";
import { deferralHeadline } from "./deferralText";

/**
 * A corrected stage's subtasks, read as a sequence of rounds rather than a flat list.
 *
 * Exists because corrections stopped being exceptional. `correctStage` appends a
 * subtask and keeps everything the stage already produced, which is the whole saving
 * — and the report rendered the result as one `## What the agent reported` after
 * another, identical in appearance, in chronological order, with the finding each
 * round was acting on shown nowhere at all. A stage fixed twice and then amended
 * after an upstream correction presented four indistinguishable accounts of itself
 * and left the reader to work out which one still stood.
 *
 * Three facts the reader cannot derive from the replies, and all three are here:
 * which round is the version that stands, what each repair was asked to fix, and
 * whether a repair was the stage's own error (a correction) or the ground moving
 * under it (an amendment). The last distinction is the one `Subtask.correction.upstream`
 * exists to keep, and a report that conflates them points the next investigation at
 * the wrong stage.
 *
 * Pure, and derived entirely from what is already persisted — nothing here needs a
 * new field, so it reads correctly for stages recorded by earlier builds.
 */

export type StageRoundKind = "run" | "correction" | "amendment";

export interface StageRound {
  subtask: Subtask;
  kind: StageRoundKind;
  /** 1-based within its own kind, so "Correction 2" and "Amendment 2" both count from one. */
  ordinal: number;
  /**
   * What this round was asked to fix, in one line. Corrections only: an amendment's
   * `finding` is the composed instruction `upstreamAmendmentNote` wrote, not a
   * finding, and headlining boilerplate would say nothing.
   */
  finding?: string;
  /** The stage whose correction caused this amendment. */
  upstreamStageName?: string;
  /** The newest round: the account that stands. False for every round of an uncorrected stage. */
  latest: boolean;
}

/**
 * The stage's subtasks as rounds, in the order they happened.
 *
 * A stage split into three units has three `run` rounds and no `latest` — the units
 * are one round of work done in parallel, and marking the last-listed of them as the
 * version that stands would be a statement about nothing.
 */
export function stageRounds(stage: TaskStage): StageRound[] {
  const counts: Record<StageRoundKind, number> = { run: 0, correction: 0, amendment: 0 };
  const repaired = stage.subtasks.some((subtask) => subtask.correction);

  return stage.subtasks.map((subtask, index) => {
    const kind: StageRoundKind = !subtask.correction
      ? "run"
      : subtask.correction.upstream
        ? "amendment"
        : "correction";
    counts[kind] += 1;
    return {
      subtask,
      kind,
      ordinal: counts[kind],
      finding:
        kind === "correction" ? deferralHeadline(subtask.correction!.finding) : undefined,
      upstreamStageName: subtask.correction?.upstream?.stageName,
      latest: repaired && index === stage.subtasks.length - 1,
    };
  });
}

/**
 * How the stage got to its current state, or undefined when it simply ran.
 *
 * Undefined rather than "1 run" is the same rule the scope declarations follow: a
 * stage nothing has corrected reads exactly as it did before this existed, so the
 * line appears only where it is telling the reader something.
 */
export function summariseStageHistory(stage: TaskStage): string | undefined {
  const rounds = stageRounds(stage);
  const corrections = rounds.filter((round) => round.kind === "correction").length;
  const amendments = rounds.filter((round) => round.kind === "amendment");
  if (corrections === 0 && amendments.length === 0) return undefined;

  const parts: string[] = ["the original run"];
  if (corrections > 0) parts.push(`${corrections} correction${corrections === 1 ? "" : "s"}`);
  if (amendments.length > 0) {
    // Named, because "1 amendment" reads as this stage having gone wrong again when it
    // is a record of it having been right and something upstream having moved. The
    // distinct stages, not one per amendment: two amendments after the same correction
    // are one event as far as the reader's next question goes.
    const upstream = [
      ...new Set(amendments.map((round) => round.upstreamStageName).filter(Boolean)),
    ];
    parts.push(
      `${amendments.length} amendment${amendments.length === 1 ? "" : "s"}` +
        (upstream.length > 0 ? ` after ${upstream.map((name) => `"${name}"`).join(" and ")} changed` : ""),
    );
  }

  const listed =
    parts.length === 2
      ? `${parts[0]}, then ${parts[1]}`
      : `${parts.slice(0, -1).join(", ")}, then ${parts[parts.length - 1]}`;
  return `${listed}. The last of them below is the version that stands.`;
}

/** A round's heading: what it was, which number it is, and what it was asked to fix. */
export function roundHeading(round: StageRound, named: boolean): string | undefined {
  if (round.kind === "run") return named ? round.subtask.title : undefined;
  if (round.kind === "amendment") {
    return (
      `${round.subtask.title} — brought into line after ` +
      `${round.upstreamStageName ? `"${round.upstreamStageName}"` : "an earlier stage"} was corrected`
    );
  }
  return round.finding
    ? `${round.subtask.title} — asked to fix: ${round.finding}`
    : round.subtask.title;
}
