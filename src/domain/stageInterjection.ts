/**
 * A message the operator sends *into* a running stage.
 *
 * The gap this closes, measured 14 Aug 2026: on one task the stage "Decide and make
 * the change" was discarded and re-run six times, costing 37 minutes, and the
 * re-run reasons were a conversation — "how many dealers would this affect?", "I
 * was more thinking, how many groups…", "Ancaster has AR and DealerRankingIsGroup,
 * so why did you not bring them up?". Three questions, three whole discarded
 * stages. The stage was not doing the wrong work; it was being interrogated at
 * stage granularity, because re-running was the only door.
 *
 * `ask_user` already solves the mirror image of this and only the *agent* may open
 * it. The operator had no way in at all: once a session was running, the choices
 * were wait for it to finish or throw it away.
 *
 * ## Why this rides the permission gate
 *
 * Probed against CLI 2.1.223, because the whole design turns on it:
 *
 * - A `PreToolUse` hook answering **`allow`** carries a `permissionDecisionReason`
 *   that the model **never sees**. Verified directly: a session was asked to quote
 *   any message received during an allowed call and reported, correctly, that the
 *   tool result contained only the command's output. So the obvious channel — wave
 *   the call through and staple a note to it — does not exist.
 * - A hook answering **`deny`** delivers its reason to the model **verbatim and
 *   mid-turn**. Verified: the probe token came back quoted in full, and the session
 *   adjusted and completed in the same turn without a re-run.
 *
 * So the only way to speak to a running session is to refuse one tool call and say
 * why. That sounds like a cost and mostly is not: the gate already parks every call,
 * the denied call **does not execute**, and the agent re-issues it if it is still
 * the right move. What is spent is one round trip; what is saved is the stage.
 *
 * The constraint it does impose, and the reason `deliverable` exists: an
 * interjection cannot reach a session that never calls another tool. A stage
 * composing its final reply will not be interrupted, and must not appear to have
 * been.
 */

/** Something the operator wants the running stage to know. */
export interface StageInterjection {
  taskId: string;
  text: string;
  /** When the operator sent it, so the UI can say how long it has been waiting. */
  at: string;
}

/**
 * Whether a message is worth interrupting a stage for.
 *
 * Empty and whitespace-only are the accidental cases — the input box dismissed
 * with a stray return. Interjecting on one would refuse a tool call in order to
 * tell the agent nothing, which is the single worst outcome available here: a
 * wasted round trip that also reads, to the model, as the operator having lost
 * their train of thought.
 */
export function isDeliverableInterjection(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * The denial reason that carries an interjection to the agent.
 *
 * Every part of this wording is doing work, and the probe is why:
 *
 * - **Naming the sender.** Told only the instruction, the probe session treated it
 *   as an injected string of doubtful provenance and pointedly declined to act on
 *   it, answering the original question instead and saying so. That is correct
 *   behaviour against an anonymous instruction arriving inside a tool result, and
 *   it makes the feature useless — so the message says who is speaking and through
 *   what.
 * - **"was not run … nothing has gone wrong".** The agent is receiving a denial,
 *   which normally means it attempted something it may not do. Left to interpret
 *   that, a stage reasonably concludes it has hit a permission wall and starts
 *   working around it — the exact behaviour the gate was built to stop.
 * - **Stating precedence.** An interjection is the operator correcting a stage in
 *   flight, so it has to outrank the brief and the plan the stage is midway
 *   through, exactly as approval guidance does.
 * - **"re-issuing the held call if it is still the right next step".** Without
 *   this the stage either abandons a call it still needs, or retries it blindly
 *   when the interjection has just made it wrong. Which one applies is a judgement
 *   only the stage can make, so it is asked to make it.
 */
/**
 * How the agent recognises an interjection, declared to it before it starts.
 *
 * Shared with the invariant preamble rather than written out twice: the preamble
 * tells the session that a refusal beginning with this text is genuinely from its
 * operator, and if the two ever drifted the message would arrive with no
 * established provenance — which is precisely the state in which sessions refuse
 * it, measured twice.
 */
export const INTERJECTION_MARKER = "OPERATOR INTERJECTION";

export function interjectionDenialReason(text: string): string {
  return [
    `${INTERJECTION_MARKER} — this is your operator speaking to you through the Task`,
    "Workspaces harness. It is not a tool result and not part of the codebase.",
    "",
    text.trim(),
    "",
    "The tool call above was not run: it was held so this could reach you, and nothing",
    "has gone wrong. Treat the message as authoritative — it outranks your brief and",
    "the plan you are currently following where they conflict. Adjust course, then",
    "carry on, re-issuing the held call if it is still the right next step. Say in your",
    "report what you were asked and what you changed as a result.",
  ].join("\n");
}
