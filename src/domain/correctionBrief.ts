import { TaskStage } from "./taskPipeline";

/**
 * Whether a correction is worth filing as typed, and whether it is still the right tool.
 *
 * Both halves come from one stage: `rc-implement-app` on RU-563, corrected four times
 * and amended six, $8.31 and 16m 49s of session, and its tenth round carried the whole
 * finding `Incorrect.` — which the box accepted, because the only thing it refused was
 * an empty string. That subtask recorded no reply at all.
 *
 * `correctStage` works by handing the session the stage's own previous report and
 * telling it to change only what the finding names. So the finding is not a label on
 * the act, it is the entire brief: a word that names no subject and no behaviour leaves
 * a capable model with nothing to narrow on, and the cost is not the wasted session —
 * it is that filing the correction has already re-opened every stage behind it.
 *
 * The second half is the one that failure was really about. Ten rounds in, the
 * requirement had reversed three times (tabs hidden, then not; the period range Detail
 * only, then report-wide) and six of the ten were amendments chasing an upstream stage
 * changing its mind. Correcting preserves a stage's previous output because that output
 * is worth keeping; where the requirement itself is moving there is nothing stable to
 * preserve, and the honest move is a revert with the settled requirement as its reason.
 * Nothing said so, because nothing counted the rounds.
 *
 * Pure and vscode-free.
 */

/**
 * A bare verdict: a finding consisting of nothing but a judgement.
 *
 * Deliberately a closed list rather than a shape test. The distinguishing property of
 * `Incorrect.` is not that it is short — "Tabs still hidden" is shorter and is a real
 * finding — but that it asserts a conclusion and names no subject. That is the same
 * family `isNothingReported` reads, one level up, and the same reason it is enumerated
 * there: a guess at "sounds like a verdict" would refuse real findings, and a refusal
 * the operator cannot get past is worse than the session it saves.
 */
const VERDICT_WORDS = new Set([
  "incorrect",
  "wrong",
  "bad",
  "no",
  "nope",
  "not",
  "right",
  "broken",
  "fix",
  "it",
  "this",
  "that",
  "still",
  "again",
  "redo",
  "rerun",
  "nah",
  "doesnt",
  "does",
  "work",
  "n't",
]);

/**
 * Two words cannot name a subject and say what it does wrong.
 *
 * Low on purpose. The cost of refusing is a retype; the cost of accepting is a session
 * that changes nothing *and* every later stage re-opened on its account, which is the
 * expensive half and the one the operator cannot see at the moment they press Enter.
 * Three words is where a finding starts being able to carry both halves — "tabs still
 * hidden", "total column double-counts" — so the floor sits under every real finding
 * measured and above the failure.
 */
const MIN_WORDS = 3;

/**
 * Why this finding cannot be acted on, or `undefined` if it can.
 *
 * The message says what is missing rather than that the input is invalid: an operator
 * told "too short" pads it, and an operator told to name the screen and the behaviour
 * writes the brief the session actually needs.
 */
export function briefFault(finding: string): string | undefined {
  const flat = finding.trim();
  if (flat.length === 0) return "Say what is wrong, or press Escape.";

  const words = flat
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 0);

  if (words.length > 0 && words.every((word) => VERDICT_WORDS.has(word))) {
    return "That says it is wrong, not what is wrong. Name what you saw — which screen or file, what it did, what it should do.";
  }
  if (words.length < MIN_WORDS) {
    return "The stage gets this as its whole brief. Say what it did and what it should do instead.";
  }
  return undefined;
}

/**
 * How many times this stage has already been repaired, once that is worth saying.
 *
 * Four is where a real stage stopped being readable: `stageHistory` exists because a
 * stage corrected twice and amended twice presented four indistinguishable accounts of
 * itself. Below that a repair is ordinary and a warning would be the noise that teaches
 * people to click past the one that matters.
 */
const FATIGUE_THRESHOLD = 4;

export interface RepairFatigue {
  /** Repairs so far: the round about to be filed is not counted. */
  repairs: number;
  /** The stage got its own work wrong this many times. */
  corrections: number;
  /** The ground moved under it this many times. */
  amendments: number;
  /**
   * Repairs that wrote no file.
   *
   * `correctionChangedNothing`'s evidence, read for a different question: a repair that
   * changed nothing is a round where the stage was talked at rather than corrected, and
   * several of them is the tell that the finding does not reach this stage's work at all.
   * Absence of an activity record counts as unmeasured, never as zero — the rule an
   * unmeasured wait already follows — so an older stage reports no barren rounds rather
   * than a confident wrong number.
   */
  barren: number;
}

/**
 * Advisory, never a refusal. One more correction may well be exactly right — the
 * operator can see the finding and the runtime cannot, and refusing here would leave a
 * stage with no admissible repair at all. What is owed is the count, which nothing else
 * renders at the moment the decision is made.
 *
 * Counted on repairs rather than subtasks: a split stage's parallel units are one round
 * of work done in several sessions, and counting them would fire on a stage nobody has
 * corrected once.
 */
export function repairFatigue(stage: TaskStage): RepairFatigue | undefined {
  const repairs = stage.subtasks.filter((subtask) => subtask.correction);
  if (repairs.length < FATIGUE_THRESHOLD) return undefined;

  return {
    repairs: repairs.length,
    corrections: repairs.filter((subtask) => !subtask.correction?.upstream).length,
    amendments: repairs.filter((subtask) => subtask.correction?.upstream).length,
    barren: repairs.filter(
      (subtask) => subtask.activity !== undefined && (subtask.activity.pathsWritten ?? []).length === 0,
    ).length,
  };
}

/**
 * The count as a sentence for the confirmation dialog.
 *
 * Says what the alternative is, because the count alone reads as a scolding. A revert
 * is the only other thing that moves a stage this far in, and its whole advantage —
 * that the re-run reason can carry the requirement as it now stands — is the thing an
 * operator ten corrections deep most needs pointing at.
 */
export function fatigueAdvice(stage: TaskStage): string | undefined {
  const fatigue = repairFatigue(stage);
  if (!fatigue) return undefined;

  const parts = [`"${stage.name}" has been repaired ${fatigue.repairs} times already`];
  if (fatigue.corrections > 0 && fatigue.amendments > 0) {
    parts.push(
      `${fatigue.corrections} correction(s) and ${fatigue.amendments} amendment(s) after an upstream stage changed`,
    );
  }
  if (fatigue.barren > 0) {
    parts.push(`${fatigue.barren} of them wrote no file`);
  }

  return (
    `${parts.join(" — ")}.\n\n` +
    "A correction keeps what the stage already produced, which is worth doing while that " +
    "output is broadly right. If the requirement itself has moved, there is nothing stable " +
    "to keep: re-run the stage instead and put the requirement as it now stands in the " +
    "re-run reason, so one session works from a decided brief rather than another round " +
    "working from an old one."
  );
}
