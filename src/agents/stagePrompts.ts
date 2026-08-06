import { Subtask, TaskStage } from "../domain/taskPipeline";
import { SubtaskSpec } from "../domain/pipelineEngine";

/**
 * Prompts and reply parsers for driving a pipeline.
 *
 * Every prompt here is written for a session with **no prior context** — that is
 * the whole point of subtask-per-session. Each therefore restates the task, the
 * stage's intent and the boundaries of what this unit of work may touch, rather
 * than assuming a conversation.
 *
 * Pure and vscode-free, so the prompts and the tolerant parsing are unit-tested.
 */

export interface StageContext {
  taskName: string;
  taskDescription?: string;
  branchName: string;
  baseBranch: string;
  /**
   * Where the project keeps its own documentation, if anywhere.
   *
   * This is the harness's only durable memory. Subtask-per-session means every
   * stage starts cold and re-derives whatever the last one worked out, and that
   * rediscovery is a large share of a route's cost. A document in the repository
   * is the one place a finding can outlive the session that produced it.
   */
  docsPath?: string;
  /**
   * What the operator said while approving earlier stages, oldest first.
   *
   * Carried into every later stage because guidance given at a gate is almost
   * always about the work that follows — "deploy only this project" is worthless
   * if it expires at the next stage boundary.
   */
  guidance?: string[];
  /**
   * What earlier stages concluded, oldest first.
   *
   * The counterweight to a fresh session per subtask: independence is worth
   * paying for, re-deriving what the last stage established is not.
   */
  handoffs?: { stageName: string; text: string }[];
}

/**
 * Marker a stage uses to ask for information instead of guessing. Recognised by
 * `parseNeedsInfo`, which pauses the route and puts the question to the user.
 */
export const NEEDS_INFO_MARKER = "NEEDS-INFO:";

/**
 * How a review stage states whether the work may proceed.
 *
 * Asked for explicitly because the alternative is inferring it from prose, and
 * that inference was wrong in the direction that matters: a review with one
 * blocker and a long "everything else is fine" section was read as fourteen
 * blockers. A verdict a reviewer states cannot be mis-parsed into a route that
 * stops for nothing, or worse, one that deploys over something real.
 */
export const VERDICT_MARKER = "VERDICT:";

/** What a review concluded about whether the work may proceed. */
export type ReviewVerdict = "pass" | "block";

/**
 * Reads the verdict line, or undefined when the reply has none.
 *
 * Undefined matters: it means "this review did not say", which is different from
 * "this review said pass". The caller falls back to reading the findings rather
 * than assuming the work is clear.
 */
export function parseVerdict(reply: string): ReviewVerdict | undefined {
  // Last occurrence wins: the marker is asked for as a final line, and a review
  // that quotes the instruction earlier should not be read as its own verdict.
  const matches = [...reply.matchAll(/^\s*VERDICT:\s*(pass|block)\b/gim)];
  const last = matches[matches.length - 1];
  return last ? (last[1].toLowerCase() as ReviewVerdict) : undefined;
}

/**
 * The reply with the verdict line removed.
 *
 * The marker is a protocol between the harness and the agent, and it was reaching
 * the reader untouched: a report ending in a bare "VERDICT: block" reads as
 * machinery leaking into a document about stored procedures. Stripped once parsed,
 * so what is persisted, reported and handed to later stages is only the review.
 */
export function stripVerdict(reply: string): string {
  return reply
    .replace(/^[ \t]*VERDICT:[ \t]*(?:pass|block)\b.*$/gim, "")
    // A removed line in the middle would otherwise leave a gap wide enough to read
    // as a section break.
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Shared preamble: who you are, what you are working on, and how to ask.
 *
 * The escape hatch matters more than it looks. A brief is often thin — a bare
 * ticket reference — and a stage with no way to ask will invent the requirement
 * and proceed confidently. Asking has to be an available, explicitly sanctioned
 * move, or it will not happen.
 */
function preamble(context: StageContext, stage: TaskStage): string {
  return [
    // Invariant text first, task-specific text last. Prompt caching matches on a
    // *prefix*, so leading with "Task: <name>" made every stage's prompt differ from
    // the first character and nothing was reusable across the dozen sessions a route
    // spawns. This block is byte-identical for every stage of every task, which is
    // the only way any of it can be cached.
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
    `If you do not have that tool, reply with exactly "${NEEDS_INFO_MARKER}" followed`,
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
    // In the invariant block, because it applies to every stage of every task and
    // because the failure it prevents is silent: a stage that switched branches to
    // look for something found the branch it switched to, reported the absence
    // truthfully, and left a review that was about the wrong tree entirely.
    `You are already in the worktree and on the branch for this task. Unless this`,
    `stage is told otherwise below, do not run "git checkout", "git switch" or`,
    `anything else that changes which branch is checked out here — the worktree is`,
    `the task, and moving it makes every following stage report on the wrong tree.`,
    `If what you need is on another branch, say so and stop rather than going to`,
    `get it.`,
    ...(context.docsPath ? ["", docsGuidance(context.docsPath)] : []),

    // Everything below varies per task and per stage, so it comes after the block
    // above — see the note at the top of this function.
    "",
    `Task: ${context.taskName}`,
    context.taskDescription ? `Brief: ${context.taskDescription}` : "",
    `Branch: ${context.branchName} (based on ${context.baseBranch})`,
    `Stage: ${stage.name}`,
    // The exception to the rule above, and it lives down here rather than in that
    // block so the block stays byte-identical across stages and therefore cacheable.
    // Promotion is the case: a UAT promotion goes through a PR, and a live publish
    // runs out of the standing publish worktrees.
    ...(stage.mayChangeBranch
      ? [
          `Unlike the general rule above, this stage MAY change which branch is`,
          `checked out, because moving is part of its work. Return the worktree to`,
          `${context.branchName} when you are finished, and say so — the stages after`,
          `you refuse to run until it is back, since they would otherwise report on`,
          `whatever tree you left behind.`,
        ]
      : []),
    ...(context.handoffs && context.handoffs.length > 0
      ? [
          "",
          "Earlier stages of this task concluded the following. Treat it as established",
          "and do not re-derive it; go and look only if something contradicts it:",
          ...context.handoffs.map(
            (handoff) => `\n[${handoff.stageName}]\n${handoff.text}`,
          ),
        ]
      : []),
    ...(context.guidance && context.guidance.length > 0
      ? [
          "",
          "The operator has given the following instructions while approving earlier",
          "stages. They override your own judgement and the brief where they conflict:",
          ...context.guidance.map((note) => `- ${note}`),
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Guidance for reading and maintaining the project's own documentation.
 *
 * Both halves matter. Reading first is the cheap half: business rules and
 * structure that the code does not state are exactly what a cold session would
 * otherwise reconstruct from scratch. Writing back is what stops the next stage
 * paying that cost again — without it, every session in every route rediscovers
 * the same things and throws the result away when it ends.
 *
 * Bounded deliberately: a stage that writes down what the code already says
 * produces documentation nobody trusts, and stale docs are worse than none.
 */
function docsGuidance(docsPath: string): string {
  return [
    `Project documentation lives in ${docsPath}. Read what is relevant there before`,
    `exploring the code — it records business rules, data flows and structure that`,
    `the code alone does not explain, and you have no memory of earlier stages.`,
    "",
    `If this stage establishes durable knowledge of that kind — a business rule you`,
    `had to work out, a data flow, a structural decision and its reason — add or`,
    `update a document in ${docsPath} as part of the work, and say which file you`,
    `changed. Keep it to what outlives this task: not progress notes, not a summary`,
    `of your changes, and nothing the code already states plainly. If you found an`,
    `existing document wrong or out of date, correcting it is part of the job.`,
  ].join("\n");
}

/**
 * Asks a planning agent to break a splittable stage into subtasks.
 *
 * Constrained deliberately: each subtask becomes its own fresh session, so they
 * must be independently executable and ordered, and there must be few of them —
 * an eight-way split produces eight cold starts and usually means the stage was
 * really one piece of work.
 */
export function splitPrompt(context: StageContext, stage: TaskStage): string {
  return `${preamble(context, stage)}

Break this stage into an ordered list of subtasks. Do not implement anything yet.

Stage intent: ${stage.intent}

Each subtask runs in its own fresh session with no memory of the others, so each must:
- be independently executable from the current state of the code,
- state its own objective without referring to "the previous subtask",
- be a meaningful unit — not a single file edit.

Produce between 1 and 5 subtasks. Prefer fewer. If the stage is genuinely one
piece of work, return exactly one.

Reply with only a numbered list, one subtask per line, in this format:

1. <short title> — <what to do, in one or two sentences>
2. <short title> — <what to do, in one or two sentences>`;
}

/**
 * Asks a review stage to state its verdict, and only a review stage.
 *
 * A stage that *does* work has no verdict to give: whether the build passed is a
 * fact about a process, not an opinion, and asking an implementation stage to
 * declare itself clear would be the same self-certification the harness exists to
 * prevent.
 */
function verdictInstruction(stage: TaskStage): string {
  if (stage.kind !== "codeReview" && stage.kind !== "domainReview") return "";
  // Where the line goes has to account for the handoff block, or a review asked
  // for both is given two instructions that cannot both be obeyed — and which one
  // it drops is a coin toss, with the verdict being the one that stops a route.
  const position = stage.handoff
    ? `Put the verdict on its own line at the very end, after the handoff block`
    : `End your reply with a single line`;
  return `

${position}, exactly "${VERDICT_MARKER} pass" or
"${VERDICT_MARKER} block", and nothing after it. Use "block" when you found
something that should be fixed before the work goes any further; use "pass" when
what you found is advisory — pre-existing, cosmetic, or a suggestion someone may
reasonably decline. Judge only what this change did: a long-standing problem you
noticed in passing is not a reason to block, and say so in that case rather than
staying silent about it.`;
}

/**
 * How a stage declines work it judges to belong to another stage.
 *
 * Every stage was already told to say so rather than reach outside its objective,
 * and every stage did — in prose, at the end of a reply, which nothing read. Work
 * belonging to *no* stage was therefore declined by each one in turn and surfaced
 * only where it finally bit: a live publish halted on a structure nobody had
 * created, several stages after the first agent noticed it was missing.
 *
 * A marker makes the decline a fact the engine holds rather than a sentence in a
 * document, which is the same move `NEEDS-INFO` and `VERDICT` already made.
 */
export const DEFERRED_MARKER = "DEFERRED:";

/**
 * How a stage reports that it did not do its work at all.
 *
 * Distinct from `DEFERRED`, which says "this belongs to another stage", and from
 * `VERDICT: block`, which is a review's judgement about someone else's work. This
 * says "my own objective went undone, and here is why".
 *
 * The gap it closes cost a live publish. A deployment stage has only two ways to
 * fail — the session errors, or a `verify` command exits non-zero — so a stage with
 * no `verify` that *correctly refused* was recorded as `done`, the route passed it,
 * and the live verification gates were offered for a publish that never happened.
 * The agent's reasoning was excellent and entirely in prose, which nothing read.
 *
 * Deliberately one-directional: there is no marker for "I succeeded". A stage that
 * does work has no verdict to give on itself, and asking one to declare itself clear
 * would be the self-certification the harness exists to remove. Reporting a refusal
 * is not a claim of success, so only the refusal is asked for.
 */
export const BLOCKED_MARKER = "BLOCKED:";

/**
 * How a stage names something only a human can do.
 *
 * The fourth instance of one failure mode. A promote stage prints a pull-request link
 * that must be opened; a publish stage names a registration in a third party's console
 * that is in no cherry-pick. Routes already ask for these — "say for each whether it
 * was done or still needs a human with console access" — and the answer arrived as
 * prose in a reply nothing parsed, so the step was skipped and the promotion was
 * quietly incomplete.
 *
 * Distinct from the three neighbours it sits with. `DEFERRED` is work for another
 * *stage*; `BLOCKED` is this stage unable to start; `NEEDS-INFO` is a question whose
 * answer lets the stage continue. This is work for the *operator*, where the stage did
 * its part and the remaining step is not the harness's to take.
 */
export const ACTION_MARKER = "ACTION:";

/**
 * Everything a reply asks the operator to do, in the stage's own words.
 *
 * All occurrences, like `DEFERRED` and unlike `BLOCKED`: one stage can legitimately
 * produce several — a PR to merge and a console registration per tenant.
 */
export function parseActions(reply: string): string[] {
  const items: string[] = [];
  for (const match of reply.matchAll(/^[ \t]*ACTION:[ \t]*(.+)$/gim)) {
    const text = match[1].trim();
    if (text) items.push(text);
  }
  return items;
}

/** The reply without its action lines. See `stripBlocked` on the newline collapse. */
export function stripActions(reply: string): string {
  return reply
    .replace(/^[ \t]*ACTION:[ \t]*.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Asks a stage to name the steps it cannot take itself. */
function actionInstruction(): string {
  return `

If completing this work needs a step only a person can take — a pull request to
open or merge, a registration in a third party's console, a firewall rule, a
credential provisioned — put each one on its own line starting exactly
"${ACTION_MARKER}" followed by what to do, including any URL verbatim. One line per
step. These are recorded and the route stops until they are dealt with, so a step
named here is not lost; a step described only in your prose is. Do not use these
lines for work you did yourself, and do not use them to ask a question — say
"${NEEDS_INFO_MARKER}" for that.`;
}

/**
 * Everything the harness reads out of a stage's reply, in the one order that is
 * correct, plus the report half that a human and every later stage should see.
 *
 * The order is the whole reason this exists, and it was previously expressed only as
 * adjacency and comments inside `runSubtask`:
 *
 *   1. The verdict comes off first, so a reply ending "HANDOFF: <block> VERDICT: block"
 *      does not carry the protocol line into the block.
 *   2. The handoff split comes next, and defines the scope for everything after it.
 *      Everything downstream — findings, checklist, report — should see only the report
 *      half.
 *   3. Deferrals, refusals and actions are read from the report half *only*. A handoff
 *      saying "I deferred the export structure" is describing a decline, not making a
 *      second one, and counting it twice holds a route on an item with no separate
 *      existence.
 *
 * Pure, so each ordering rule can be pinned by a test rather than rediscovered.
 */
export interface StageReply {
  /** A review's judgement, when it gave one. */
  verdict: "pass" | "block" | undefined;
  /** The distillable block a handoff stage wrote, before distillation. */
  handoff: string | undefined;
  /** Work this stage says belongs to another. */
  deferrals: string[];
  /** Why this stage did not do its own work, when it says so. */
  blocked: string | undefined;
  /** Steps only the operator can take. */
  actions: string[];
  /** What a human and every later stage should read: markers removed. */
  report: string;
}

export function readStageReply(text: string): StageReply {
  const verdict = parseVerdict(text);
  const withoutVerdict = stripVerdict(text);

  const split = splitStageHandoff(withoutVerdict);
  let report = split.report;

  const deferrals = parseDeferrals(report);
  report = stripDeferrals(report);

  const blocked = parseBlocked(report);
  report = stripBlocked(report);

  const actions = parseActions(report);
  report = stripActions(report);

  return { verdict, handoff: split.handoff, deferrals, blocked, actions, report };
}

/**
 * The reason a reply gives for not doing its work, if it gives one.
 *
 * Anchored to the start of a line, like `DEFERRED`, so the word in prose — "the
 * migration is blocked on UAT" — is not read as the marker. Only the first is
 * returned: a stage that did not act has one reason for it, and treating a second
 * mention as a second refusal would double-count one event.
 */
export function parseBlocked(reply: string): string | undefined {
  const match = /^[ \t]*BLOCKED:[ \t]*(.+)$/im.exec(reply);
  const text = match?.[1]?.trim();
  return text ? text : undefined;
}

/**
 * The reply without its blocked line, which is protocol rather than report.
 *
 * The newline collapse matters as much as the removal, for the reason `stripVerdict`
 * and `stripDeferrals` already carry it: the marker usually has prose after it, so
 * removing the line leaves a gap wide enough to read as a section break — in the one
 * report a human opens precisely because the route was held.
 */
export function stripBlocked(reply: string): string {
  return reply
    .replace(/^[ \t]*BLOCKED:[ \t]*.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Tells a stage that does work how to say it could not do it.
 *
 * Offered to every stage except a review, which has `VERDICT` for the same purpose
 * and would otherwise be given two overlapping protocols to choose between.
 */
function blockedInstruction(stage: TaskStage): string {
  if (stage.kind === "codeReview" || stage.kind === "domainReview") return "";
  return `

If you cannot do this stage's work at all — a prerequisite is missing, an earlier
stage's output never arrived, the thing you were told to act on does not exist —
then do not do part of it and do not describe the problem only in prose. Say so
with a line starting exactly "${BLOCKED_MARKER}" followed by one sentence naming
what is missing. Then stop. Refusing is a correct outcome and it is recorded as
one; what must not happen is this stage being marked done because the session
ended tidily. Never use this line to report work you did complete.`;
}

/**
 * Every piece of work a reply declined, in the stage's own words.
 *
 * Anchored to the start of a line so the word inside prose — "I deferred to the
 * existing convention" — is not read as a decline. The text is kept verbatim
 * because what a later reader needs is what the stage actually saw, not a
 * normalised version of it.
 */
export function parseDeferrals(reply: string): string[] {
  const items: string[] = [];
  for (const match of reply.matchAll(/^[ \t]*DEFERRED:[ \t]*(.+)$/gim)) {
    const text = match[1].trim();
    if (text) items.push(text);
  }
  return items;
}

/**
 * The reply without its deferral lines.
 *
 * Stripped for the same reason the verdict is: it is protocol between the harness
 * and the agent. Left in, the same item appears twice in front of a reader — once
 * as a raw marker line in the middle of a report, and once as the item the route
 * is actually holding on.
 */
export function stripDeferrals(reply: string): string {
  return reply
    .replace(/^[ \t]*DEFERRED:[ \t]*.+$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Introduces the block a stage writes for the stages after it.
 *
 * A marker rather than a separate turn. Asking for the handoff in a second
 * exchange would cost a full extra round trip per stage — the model re-reading
 * everything it just did — to produce text it already has in hand. The verdict
 * line established the pattern: a protocol line inside the reply, parsed out and
 * stripped before anything human-facing sees it.
 */
export const HANDOFF_MARKER = "HANDOFF:";

/**
 * Asks a stage to end with a distilled handoff, and only a stage the route marks
 * as one worth carrying forward.
 *
 * The stage's reply was previously carried forward whole and cut at 1500
 * characters, which is close to the worst possible selection: a reply is written
 * for a person reading a report, so its opening is context and restatement, and
 * the part a later stage actually needs — what was decided, what is left, what to
 * do next — is at the end, where the cut lands. Asking for the summary explicitly
 * puts the choice of what survives with the stage that knows.
 */
function handoffInstruction(stage: TaskStage): string {
  if (!stage.handoff) return "";
  return `

After your reply, add a line containing only "${HANDOFF_MARKER}" and then a short
handoff for the later stages of this workflow. They run in fresh sessions with no
memory of yours, and this is the only thing of yours they will see. Use these
headings, and keep the whole block under 250 words:

## Summary
Where the work stands, in one or two sentences.

## Done
## Remaining
## Decisions
## Files
## Next step

Under "Decisions", record only what a later stage could NOT work out by reading
the code: constraints you were given, approaches you rejected and why, assumptions
you had to make. Do not describe the diff — the code is on disk and will be re-read
— and do not restate the brief. Everything above the marker is for a person; the
block below it is for the next stage.`;
}

/**
 * Separates a reply's report from the handoff block it ends with.
 *
 * The last marker wins, so a stage that quotes the instruction earlier in its
 * reply does not have its own explanation parsed as the handoff. A reply with no
 * marker returns no handoff at all rather than a guess — the caller then falls
 * back to carrying the reply forward, which is what it did before.
 */
export function splitStageHandoff(reply: string): {
  report: string;
  handoff?: string;
} {
  const matches = [...reply.matchAll(/^[ \t]*HANDOFF:[ \t]*$/gim)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return { report: reply };

  const handoff = reply.slice(last.index + last[0].length).trim();
  const report = reply.slice(0, last.index).trimEnd();
  // An empty block is the same as none: the stage announced a handoff and then
  // said nothing, and carrying an empty section forward would tell a later stage
  // this stage concluded nothing.
  if (!handoff) return { report };
  return { report, handoff };
}

/** The brief handed to a session that will execute one subtask. */
export function subtaskPrompt(
  context: StageContext,
  stage: TaskStage,
  subtask: Subtask,
): string {
  const body = `${preamble(context, stage)}

Objective: ${subtask.title}

${subtask.prompt}

Stay within this objective. If you discover work that belongs to a different
stage of the workflow, do not do it — instead write it on its own line as
"${DEFERRED_MARKER} <what needs doing, and where you think it belongs>". Use one
line per item. Something declined this way is followed up by the workflow, so it
is not lost; something merely mentioned in your reply is not.${blockedInstruction(stage)}${actionInstruction()}${handoffInstruction(stage)}${verdictInstruction(stage)}`;

  // A workflow command leads, with the brief following as its argument. Sending
  // the command alone would leave a cold session with no task, no brief and no
  // intent — and command bodies typically say "investigate this request", which
  // means nothing when there is no request in the context.
  return subtask.workflow ? `${subtask.workflow}\n\n${body}` : body;
}

/**
 * Asks a behaviour-review stage for a tester checklist. Recasts the agent from
 * judge to QA planner — the framing that makes behaviour review worth having.
 */
export function behaviourReviewPrompt(
  context: StageContext,
  stage: TaskStage,
): string {
  return `${preamble(context, stage)}

${stage.intent}

Reply with only a checklist, one item per line, each starting with "- ".
Each item must name what a human should exercise and what would indicate a regression.
Do not include items that could be settled by reading the code or by running the
automated tests — those are covered by other stages.

If nothing needs manual verification, reply with exactly: NONE`;
}

/**
 * Detects a request for information and returns the question text.
 *
 * Deliberately tolerant about position: models often preface the marker with a
 * sentence. Requires the marker to start a line so the word appearing inside prose
 * ("I considered replying NEEDS-INFO but…") does not pause the route.
 */
export function parseNeedsInfo(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) =>
    line.trimStart().toUpperCase().startsWith(NEEDS_INFO_MARKER),
  );
  if (index === -1) return undefined;

  const first = lines[index].trimStart().slice(NEEDS_INFO_MARKER.length).trim();
  const rest = lines.slice(index + 1);

  // Each question is answered on its own, so they have to be separated here.
  // Bulleted or numbered lines are the shape the prompt asks for; a reply that
  // ignores that becomes one question per non-empty line, and a single trailing
  // paragraph stays whole rather than being split at every newline.
  const bulleted: string[] = [];
  const plain: string[] = [];
  for (const raw of [first, ...rest]) {
    const line = raw.trim();
    if (!line) continue;
    const marker = /^(?:\d+[.)]|[-*+•])\s+(.*)$/.exec(line);
    if (marker?.[1]?.trim()) bulleted.push(marker[1].trim());
    else plain.push(line);
  }

  const questions = bulleted.length > 0 ? bulleted : plain.length > 0 ? [plain.join(" ")] : [];

  // A marker with nothing after it is still a request to pause; say something
  // useful rather than presenting an empty form.
  return questions.length > 0
    ? questions
    : ["The stage asked for more information but did not say what."];
}

/**
 * Parses a numbered subtask list. Tolerant of the model adding prose around it:
 * only numbered lines are taken, and a missing "—" separator falls back to using
 * the whole line as both title and prompt.
 */
export function parseSubtaskPlan(text: string): SubtaskSpec[] {
  const specs: SubtaskSpec[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const numbered = /^(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
    if (!numbered) continue;

    const body = numbered[1].trim();
    if (!body) continue;

    // Accept an em dash, en dash, hyphen or colon as the title separator.
    const split = /^(.{1,80}?)\s*(?:—|–|:|\s-\s)\s*(.+)$/.exec(body);
    if (split) {
      specs.push({ title: split[1].trim(), prompt: split[2].trim() });
    } else {
      specs.push({ title: truncateTitle(body), prompt: body });
    }
  }

  return specs;
}

/** Parses a checklist reply. "NONE" yields an empty list, which is a valid answer. */
export function parseChecklistReply(text: string): string[] {
  if (/^\s*none\s*$/i.test(text)) return [];

  const items: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const body = bullet[1].trim();
    // A lone "NONE" bullet means the same as the bare word.
    if (!body || /^none$/i.test(body)) continue;
    items.push(body);
  }
  return items;
}

function truncateTitle(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return firstSentence.length > 60 ? `${firstSentence.slice(0, 57)}…` : firstSentence;
}
