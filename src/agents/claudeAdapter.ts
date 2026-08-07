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
export function invariantProtocolBlock(markers: ProtocolMarkers): string[] {
  return [
    "You are one stage of a defined workflow and have no memory of earlier stages.",
    "",
    // Without this a re-run redoes the whole stage. A stage is the unit of re-run —
    // sending findings back, reverting, retrying after a refused tool all re-open
    // one — and a cold session reading "write the migration and a paired rollback"
    // duly writes them again, when the actual defect was a missing folder. Minutes
    // of model time to change one thing, and the correct work churned on the way.
    `This stage may have run before, and its earlier output may already be in the`,
    `worktree. Look at what is there before creating anything. Change only what is`,
    `actually wrong or missing; do not rewrite work that is already correct, and say`,
    `what you found already in place and what you changed.`,
    "",
    `If the brief does not tell you enough to do this properly — it may be only a`,
    `ticket reference — do NOT guess and do NOT proceed. First check whether the`,
    `answer is already available to you: read the code, and use any ticket tooling`,
    `this repository provides. Only ask for what you genuinely cannot find.`,
    "",
    // Two ways to ask, and the difference is what a question costs. The tool keeps
    // the session alive, so the answer arrives mid-turn and everything worked out
    // so far survives. The marker ends the session, so answering it re-runs the
    // whole subtask from scratch. The tool is preferred whenever it is there.
    `To ask, prefer the "ask_user" tool if you have it: it pauses you until a human`,
    `answers, then you carry on with everything you have already worked out. Put`,
    `every question you have into one call, each self-contained.`,
    "",
    `If you do not have that tool, reply with exactly "${markers.needsInfo}" followed`,
    `by your questions as a numbered list, one question per line, and nothing else.`,
    `Each line is answered separately, so ask one thing per line rather than`,
    `combining several into a paragraph. The work will pause and a human will answer,`,
    `but this stage will then start again from the beginning — so use the tool when`,
    `you can.`,
    "",
    // Each shell call is a process launch, and on a Windows host with on-access
    // scanning that costs of the order of a second — per process, so a four-stage
    // pipeline pays four times before doing any work. Measured on a real route,
    // shell calls averaged over ten seconds each while the file tools averaged
    // zero. Same information, two orders of magnitude apart.
    `Use the file search and file read tools to explore, not shell commands: they`,
    `run in-process, while every shell call pays a process launch. Reserve the shell`,
    `for work that genuinely needs it, and when you do use it, combine the steps`,
    `into one command rather than issuing several.`,
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
