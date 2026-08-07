/**
 * The Claude execution adapter's half of the runtime protocol.
 *
 * The runtime has two interfaces, and neither of them is a prompt: harness →
 * engine is `StageContext`, the verified engineering facts a stage needs; engine
 * → harness is the reply contract the parsers in `stagePrompts.ts` read. This
 * module is what teaches *this* engine to speak them. It belongs to the adapter,
 * not to the harness: a second execution engine brings its own version of this
 * file and its own skill, and `pipelineEngine`/`planSteps` do not move.
 *
 * Three layers, and each sits where it does for a reason:
 *
 * - **Contract** — declared here, in text that is always present, because
 *   determinism depends on it. The markers below are read by the parsers, and a
 *   reply missing them parses as *silence* — which for deferrals and plan steps
 *   is precisely the failure those markers exist to catch. This is also why the
 *   contract cannot be moved into a skill, whose loading is the model's choice.
 * - **Understanding** — belongs in a skill: when to ask rather than assume, what
 *   makes a handoff worth carrying, how specific a checklist item must be.
 * - **Correctness** — enforced by the parser. Never trust the reply to be
 *   well-formed.
 *
 * Everything here must stay **byte-identical across every stage of every task**.
 * Prompt caching matches on a prefix, so a single interpolated task name at the
 * top makes the whole block uncacheable across the dozen sessions a route spawns.
 * Anything that varies belongs after this block, in `stagePrompts.ts`.
 */

import { PROTOCOL_SKILL_NAME } from "./protocolSkill";

/** Markers the adapter must name, owned by the parsers that read them. */
export interface ProtocolMarkers {
  needsInfo: string;
}

/**
 * The invariant protocol block, as lines.
 *
 * Takes its markers as a parameter rather than importing them: the adapter
 * *declares* the contract, it does not define it. Passing them in keeps the
 * dependency pointing at the parser, which is the side that enforces it.
 */
export function invariantProtocolBlock(
  markers: ProtocolMarkers,
  skillName = PROTOCOL_SKILL_NAME,
): string[] {
  return [
    "You are one stage of a defined workflow and have no memory of earlier stages.",
    "",
    // Named explicitly rather than left to the model to notice. Skill loading is the
    // model's choice, so a skill nobody mentions is a skill that loads sometimes —
    // and "sometimes" is the worst of the three possibilities, because the runs where
    // it did not load look exactly like the runs where it did until the reply is
    // parsed. It carries the judgement half only; nothing below depends on it.
    // Kept here rather than moved to the skill, unlike the rest of the judgement
    // guidance. Its failure is both silent and expensive: a cold session re-reading
    // "write the migration and a paired rollback" writes them again when the actual
    // defect was a missing folder, and nothing in the reply reveals that it did.
    `This stage may have run before, and its earlier output may already be in the`,
    `worktree. Look before creating; do not rewrite work that is already correct.`,
    "",
    `A "${skillName}" skill describes how to work inside this runtime — asking,`,
    `declining work, handing conclusions forward, accounting for a plan. Read it`,
    `before you start. If it is not available, carry on: everything you are actually`,
    `held to is stated here.`,
    "",
    // The contract, and only the contract. Every marker below is read by a parser,
    // and a reply missing one parses as silence rather than as an error — which for
    // deferrals and plan steps is the exact failure they exist to catch. This is why
    // none of it may move into the skill.
    `If the brief does not tell you enough to do this properly — it may be only a`,
    `ticket reference — do NOT guess and do NOT proceed. Prefer the "ask_user" tool`,
    `if you have it: it pauses you until a human answers, then you carry on with`,
    `everything you have already worked out.`,
    "",
    `If you do not have that tool, reply with exactly "${markers.needsInfo}" followed`,
    `by your questions as a numbered list, one question per line, and nothing else.`,
    `Each line is answered separately. The work will pause and a human will answer,`,
    `but this stage will then start again from the beginning — so use the tool when`,
    `you can.`,
    "",
    // Here because it applies to every stage of every task and because the failure
    // it prevents is silent: a stage that switched branches to look for something
    // found the branch it switched to, reported the absence truthfully, and left a
    // review that was about the wrong tree entirely.
    `You are already in the worktree and on the branch for this task. Unless this`,
    `stage is told otherwise below, do not run "git checkout", "git switch" or`,
    `anything else that changes which branch is checked out here — the worktree is`,
    `the task, and moving it makes every following stage report on the wrong tree.`,
    `If what you need is on another branch, say so and stop rather than going to`,
    `get it.`,
  ];
}
