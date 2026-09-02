import { Subtask, TaskStage } from "../domain/taskPipeline";
import { REPAIR_MARKER } from "../domain/repairProposal";
import { StageKind } from "../domain/taskRoute";
import { SubtaskSpec } from "../domain/pipelineEngine";
import {
  PlanStep,
  StepAccount,
  parseStepAccounts,
  planStepInstruction,
  stripStepAccounts,
} from "../domain/planSteps";
import { invariantProtocolBlock } from "./claudeAdapter";
import { isNothingReported } from "../domain/nothingReported";
import { splitScopeTag } from "../domain/checklistScope";
import { referenceGuidance } from "../domain/taskReferences";
import { markerLine, markerText } from "../domain/replyMarkers";

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
  /**
   * The route's stages in order, with this one marked.
   *
   * The gap this closes, which cost a real sign-off: a behaviour review raised
   * "deploy this migration to DEV" as a verification item for a human, when the route
   * already had a deployment stage that would do exactly that two steps later. The
   * stage was not wrong about the work being outstanding — it had no way to know
   * anyone was going to do it.
   *
   * A cold session cannot rediscover this at any price: the route is not in the
   * repository, not in the diff, and not in the brief. It is a deterministic fact the
   * runtime already holds, which is precisely what `StageContext` is for.
   *
   * It also gives `DEFERRED` its meaning. The engine defines a deferral as work
   * belonging to *no stage*, and until now no stage could tell that from work
   * belonging to the next one — so the honest ones over-reported and the rest said
   * nothing.
   *
   * A summary of each intent is included because a stage name alone ("Deploy") does
   * not say whether it covers the thing in hand — but the full intent is how to
   * *execute* a stage, which no other stage needs. See `summariseIntent`.
   *
   * Deliberately carries no "you are here": the marker used to sit inside this list,
   * which made the list vary per stage and ended the cached prefix here. The list is
   * now identical for every stage of a task, and the reader's own position is stated
   * after it — so the brief and the route are paid for once per task, not per stage.
   * `id` is what locates the reader, since two stages may share a name.
   */
  routeStages?: { id: string; name: string; summary: string }[];
  /**
   * The documents that govern this task, as the operator named them.
   *
   * Distinct from `docsPath`, and the distinction is the point. `docsPath` is the
   * project's standing documentation — true of every task, discovered by reading.
   * These are specific to *this* task and known only to the operator: a wireframe
   * tab, a signed-off spec, a mail thread setting an acceptance rule. A stage
   * given neither does the reasonable thing and copies the closest existing
   * feature, which was the single largest cause of corrected work measured across
   * eight live routes.
   *
   * Per-task rather than per-stage, so it sits in the cached prefix beside the
   * brief and the route outline: twenty-two sessions pay for it once.
   */
  references?: { path: string; note?: string; origin?: "operator" | "discovered" }[];
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
  const matches = [
    ...reply.matchAll(new RegExp(markerLine("VERDICT:", "\\s*(pass|block)\\b"), "gim")),
  ];
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
    .replace(new RegExp(markerLine("VERDICT:", "[ \\t]*(?:pass|block)\\b.*$"), "gim"), "")
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
/**
 * Where the reader sits in the route listed above it, as a suffix to the stage name.
 *
 * Stated after the list rather than marked inside it: a marker in the list makes the
 * list vary per stage, which ends the cached prefix at the route and costs every stage
 * the brief as well. Silent when the stage is not in the outline — a caller that passed
 * none, or one built for another stage, must not assert a position it does not know.
 */
function routePosition(routeStages: StageContext["routeStages"], stageId: string): string {
  if (!routeStages || routeStages.length === 0) return "";
  const at = routeStages.findIndex((entry) => entry.id === stageId);
  return at === -1 ? "" : ` (stage ${at + 1} of ${routeStages.length} above)`;
}

function preamble(context: StageContext, stage: TaskStage): string {
  return [
    // The invariant half lives in the Claude adapter: it is this engine's
    // declaration of the runtime protocol, not the harness's, and it must stay
    // byte-identical across every stage so prompt caching can match on the prefix.
    ...invariantProtocolBlock({ needsInfo: NEEDS_INFO_MARKER }),
    ...(context.docsPath ? ["", docsGuidance(context.docsPath)] : []),

    // Everything below varies per task and per stage, so it comes after the block
    // above — see the note at the top of this function.
    "",
    `Task: ${context.taskName}`,
    context.taskDescription ? `Brief: ${context.taskDescription}` : "",
    `Branch: ${context.branchName} (based on ${context.baseBranch})`,

    // Above the route outline and everything per-stage, so it stays inside the
    // prefix every stage of this task shares. Placed immediately after the brief
    // because that is what it qualifies: where the brief and a governing document
    // disagree, `referenceGuidance` says the document wins.
    ...referenceGuidance(
      context.references?.map((reference) => ({ ...reference, at: "" })),
    ),

    // The route sits above the per-stage lines, not below them, and that ordering is
    // the whole saving: it and the brief are the same bytes for every stage of a
    // task, so twenty-two sessions share one cached prefix instead of each paying
    // fresh for both. Anything that varies per stage has to stay below this point.
    ...(context.routeStages && context.routeStages.length > 0
      ? [
          "",
          "This task's route, in order. Every stage here has an owner: do not do another",
          "stage's work, and do not raise it as outstanding — that is what they are for.",
          "Raise only work no stage here covers.",
          ...context.routeStages.map((entry, index) => `${index + 1}. ${entry.name} — ${entry.summary}`),
        ]
      : []),

    "",
    `Stage: ${stage.name}${routePosition(context.routeStages, stage.id)}`,
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
staying silent about it.${repairInstruction(stage)}`;
}

/**
 * How a review names the stage that should fix what it found.
 *
 * Asked for only where the route declares `autoRepair`, because a marker a stage is
 * told to write and nothing acts on is worse than no marker: it reads to the model as
 * a channel that works. The rest of the reply is unchanged either way — a review that
 * writes no `REPAIR:` line holds for a person, exactly as every review did before.
 *
 * The target is asked for **by name** because deriving it was measured and rejected:
 * ordering the candidates by proximity agreed with the operator 11 times in 19. The
 * reviewer wrote the findings and knows which name a stored procedure and which name a
 * layering decision, and that is the judgement no ordering reaches.
 *
 * One line per stage, not per finding, because `correctStage` appends one correction
 * subtask and handing it a list is what makes the repair a single session rather than
 * one per finding — the same argument amendment coalescing makes.
 */
function repairInstruction(stage: TaskStage): string {
  if (!stage.autoRepair) return "";
  const targets = stage.sendBackTo ?? [];
  if (targets.length === 0) return "";
  return `

When you block, also name the stage that should fix it, as a line
"${REPAIR_MARKER}: <stage> — <what to fix>" — one line per stage, listing every
finding that stage owns. Use the stage's name exactly as the route outline gives
it; a name that matches nothing is refused and the route stops for a human
instead. Only a stage earlier than this one, and only one that could actually
change the thing you found: the stage that wrote the file is the target, not the
one that happens to sit nearest. If the fix needs a different approach rather
than an edit, do not propose a repair — block and say so, because that is a
decision for a person.`;
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
  for (const match of reply.matchAll(new RegExp(markerLine("ACTION:"), "gim"))) {
    const text = markerText(match[1], match[0]);
    if (text) items.push(text);
  }
  return items;
}

/** The reply without its action lines. See `stripBlocked` on the newline collapse. */
export function stripActions(reply: string): string {
  return reply
    .replace(new RegExp(markerLine("ACTION:", "[ \\t]*.*$"), "gim"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Asks a stage to declare work that is not its own.
 *
 * Extracted so a behaviour review can be given it too. Without it that stage had a
 * single output channel — the checklist — so work it noticed nobody had done went out
 * as a verification item, and a person was asked to deploy a migration under the
 * heading "verification items raised". The stage was not being lazy; it had one door.
 */
function deferralInstruction(): string {
  return `

If you find work that has not been done and is not yours, what to do depends entirely
on whether any stage of the workflow above owns it. Decide that first — the route is
listed for you, with each stage's objective.

**A later stage clearly owns it.** Say so in your report, in a sentence, and move on.
Do **not** mark it "${DEFERRED_MARKER}". That marker holds the route until a human
writes a sentence about who owns each item — and you have just established that the
route already owns it, so the answer is on the screen and the question is noise. One
task accumulated forty of these, thirty of them the same four observations reworded
by each stage that noticed them, and the real item was somewhere in the middle.

**No stage owns it.** This is the only case the marker is for. Ask first, while you
still have the context that found it: use your question tool if you have one, and ask
plainly — what you found, what you would do about it, and that no stage of this route
covers it. Then do what the answer says, including doing the work here if that is the
answer. Only if you cannot ask, write it as
"${DEFERRED_MARKER} <the work that needs doing>", one line per item.

Write that line as **the work, not the argument for it**: one short sentence naming
the thing somebody has to do, under about twenty words, no evidence and no history.
It is shown to a person in a single-line box asking who owns it, and a paragraph
there is five lines of reasoning to read before answering a question they usually
already know the answer to. Put the evidence in your report, where there is room for
it — the two are shown together.

The difference is the whole point, and getting it wrong the second way is expensive.
Work that belongs to nobody, written down as declined, reads to the operator exactly
like work that belongs to the next stage — so it is confirmed and forgotten, and
surfaces when something fails much later. That has already happened here: a live
publish halted on a data structure the first stage to notice it had quietly declined.
You are the cheapest point at which that gets fixed, and you are the only one who
knows it right now.

If you are unsure which case you are in, ask. A question answered in a sentence costs
far less than a defect found after it ships.`;
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
  /** Why a correction refused to be a correction, when it says so. */
  correctionDeclined: string | undefined;
  /** What the stage said about each numbered step of the plan it was given. */
  stepAccounts: StepAccount[];
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

  const correctionDeclined = parseCorrectionDeclined(report);
  report = stripCorrectionDeclined(report);

  // Read from the report half like the three above, and for the same reason: a
  // handoff that says "step 4 is still outstanding" is telling the next stage about
  // an account, not making a second one.
  const stepAccounts = parseStepAccounts(report);
  report = stripStepAccounts(report);
  // Same reason as every other marker: a report ending in bare protocol lines is
  // machinery leaking into a document a person reads.
  report = stripAssessments(report);

  return {
    verdict,
    handoff: split.handoff,
    deferrals,
    blocked,
    actions,
    correctionDeclined,
    stepAccounts,
    report,
  };
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
  const match = new RegExp(markerLine("BLOCKED:"), "im").exec(reply);
  const text = markerText(match?.[1], match?.[0]);
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
    .replace(new RegExp(markerLine("BLOCKED:", "[ \\t]*.*$"), "gim"), "")
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

If this stage's work does not get done, say so with a line starting exactly
"${BLOCKED_MARKER}" followed by one sentence naming why. Then stop. Two families of
reason, and the second is the one people write prose about instead:

- You **could not**: a prerequisite is missing, an earlier stage's output never
  arrived, the thing you were told to act on does not exist.
- You **should not**: the fix needs a change wider than this stage may make, it
  turns on a product or design decision that is not yours, or doing it would
  exceed what this stage was asked for. Concluding that the work is out of scope
  is a legitimate and useful outcome — reporting it only in prose is not.

Before you stop for the second reason, ask. If what stands between you and the work
is a decision someone could give you in a sentence, use \`ask_user\`: the answer comes
back into this same session and you carry on with everything you have worked out.
Stopping costs the whole stage and a person has to read your report to reconstruct
the question. Stop only when the decision is too large to be settled that way, or
when you cannot ask.

Either way: do not do part of the work, and do not describe the problem only in
prose. Refusing is a correct outcome and it is recorded as one; what must not happen
is this stage being marked done because the session ended tidily.
Never use this line to report work you did complete.`;
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
  for (const match of reply.matchAll(new RegExp(markerLine("DEFERRED:"), "gim"))) {
    const text = markerText(match[1], match[0]);
    // A stage answering the question rather than omitting the line. Recorded as
    // written it became an outstanding item, and an outstanding item holds the route
    // in front of the next deployment — so a stage saying "nothing" stopped a deploy
    // on the absence of work. Shared with the review-findings parser, which had the
    // identical bug: see `domain/nothingReported.ts`.
    if (text && !isNothingReported(text)) items.push(text);
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
    .replace(new RegExp(markerLine("DEFERRED:", "[ \\t]*.+$"), "gim"), "")
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
  const matches = [...reply.matchAll(new RegExp(markerLine("HANDOFF:", "[ \\t]*$"), "gim"))];
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
  /**
   * The numbered steps of this stage's plan, when it has one.
   *
   * Passed in rather than read here: the file lives in the worktree, and these
   * prompts are pure. The engine holds the stage to these numbers, so they are the
   * ones the stage is asked about — not whatever it makes of the document itself.
   */
  planSteps?: readonly PlanStep[],
): string {
  const body = `${preamble(context, stage)}

Objective: ${subtask.title}

${subtask.prompt}

Stay within this objective.${deferralInstruction()}${blockedInstruction(stage)}${actionInstruction()}${
    stage.planFile && planSteps && planSteps.length > 0
      ? planStepInstruction(stage.planFile, planSteps)
      : ""
  }${handoffInstruction(stage)}${verdictInstruction(stage)}`;

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
  /**
   * Where each item will be exercised, from the route's verification gates.
   *
   * Passed in rather than inferred because the gates are a property of the live
   * pipeline, and a review told the wrong set would tag items for a gate that does not
   * exist. Empty means the route has one pooled verification, and the tagging
   * instruction is omitted entirely — asking for a distinction the route cannot honour
   * would produce tags that go nowhere.
   */
  scopes: readonly string[] = [],
): string {
  return `${preamble(context, stage)}

${stage.intent}

Reply with a checklist, one item per line, each starting with "- ".
Each item must name what a human should exercise and what would indicate a regression.
${scopeInstruction(scopes)}

A checklist item is something a person **observes**. It is never work. If something
has to be *done* before the behaviour can be observed at all — a script run, an object
deployed, a job triggered — that is not a checklist item, whoever ends up doing it. Put
it on one of the lines below instead, and write the checklist item as the observation
that follows it.

Do not include items that could be settled by reading the code or by running the
automated tests — those are covered by other stages.

If nothing needs manual verification, reply with exactly: NONE${deferralInstruction()}${actionInstruction()}`;
}

/**
 * Tells a behaviour review which verification gate each item belongs to.
 *
 * Empty when the route declares no scopes, so a project that has not opted in sees the
 * prompt it saw before. The tag is a *hint*, not a contract: `splitScopeTag` only
 * strips one that names a declared scope, and an item tagged with anything else — or
 * not tagged at all — is still assigned to a gate rather than dropped. That is
 * deliberate. Every other marker in this protocol had to be defended against a model
 * that ignores it, and the defence here is that the fallback verifies the item in a
 * possibly-wrong place rather than in no place.
 */
function scopeInstruction(scopes: readonly string[]): string {
  if (scopes.length === 0) return "";
  const list = scopes.map((scope) => `[${scope}]`).join(" or ");
  return `
This route verifies the change in more than one place, and each item has to say where
it will be exercised. Begin every item with one of: ${list}.

  - [${scopes[0]}] Open the report for NissanGB with period 248 — the Total column should …

Choose by what the item actually needs to be true. An item that only needs the code and
the database is a ${scopes[0]} item; one that needs the change to have been deployed and
served — a menu entry, a permission, a config transform, anything about the running site
— belongs to a later one. If you are unsure, pick the later gate: an item checked too
late is an inconvenience, and one checked in a place that cannot show the problem is a
false pass.
`;
}

/** How an assessment stage reports on one stage of the route. */
/**
 * How a correction says it is the wrong tool for the finding it was given.
 *
 * The fifth instance of the failure this whole family of markers exists for, and the
 * most expensive so far, because the reply *sounded* like a refusal and the route
 * treated it as a repair. `correctionPrompt` already told the session to "say so and
 * stop" if the fix needed a change of approach — but there was nothing to say it
 * *with*. So a correction that declined ended its session without an error,
 * `finishSubtask(..., "done")` recorded a process exiting tidily, the stage settled,
 * and later stages ran on output the correction had just confirmed was wrong. The
 * prompt asked for a behaviour the parser did not look for, which is precisely what
 * "never trust the reply to be well-formed" is a rule against.
 *
 * Distinct from `BLOCKED`, which it otherwise resembles, because the remedy is
 * different and the remedy is the whole point of telling anyone. `BLOCKED` says a
 * prerequisite is missing and someone must supply it; this says the stage's output is
 * wrong in a way no targeted edit reaches, and the answer is `revertToStage` — which
 * only a human may choose, since it discards work. A single "held" state would leave
 * the operator to re-derive that distinction from prose, which is the position they
 * were in before the marker existed.
 */
export const CORRECTION_DECLINED_MARKER = "CORRECTION-DECLINED:";

/**
 * Why a correction refused, if it refused.
 *
 * First occurrence only, like `BLOCKED` and unlike `DEFERRED`: a correction is given
 * one finding and has one answer to it, so a second mention is the reply restating
 * itself rather than declining twice.
 */
export function parseCorrectionDeclined(reply: string): string | undefined {
  const match = new RegExp(markerLine("CORRECTION-DECLINED:"), "im").exec(reply);
  const text = markerText(match?.[1], match?.[0]);
  return text ? text : undefined;
}

/** The reply without its decline line. See `stripBlocked` on the newline collapse. */
export function stripCorrectionDeclined(reply: string): string {
  return reply
    .replace(new RegExp(markerLine("CORRECTION-DECLINED:", "[ \\t]*.*$"), "gim"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Prompt for repairing a stage that has already run, rather than re-running it.
 *
 * The whole economy of this rests on one thing: the session is given the stage's own
 * previous report. A re-run is expensive because it re-reads the ticket, re-derives
 * the codebase and re-decides an approach that was already decided — on one route
 * that was 15M cached tokens and 44 minutes to change a type. A correction starts
 * from what was built and what is wrong with it.
 *
 * So the instruction is narrowing, not motivating. Left to itself a capable model
 * treats a finding as an invitation to improve the surrounding code, and a
 * correction that rewrites half the stage costs what the re-run cost and invalidates
 * the reviews that had passed the rest.
 */
/**
 * What a correction to this kind of stage is allowed to change.
 *
 * `correctionPrompt` told every stage to "go straight to the code the finding names",
 * which is true of exactly one kind. A finding is written about where a problem was
 * *noticed*, and that is almost always the code — so a planning stage handed one went
 * and edited the controller. The fix was competent, narrow and correct, and it was in
 * the wrong stage: the plan still did not mention the work, so the implementation
 * stages were about to re-run cold against a document that omitted it, and no `STEP`
 * would ever have accounted for it. Work done in the wrong stage is invisible to every
 * mechanism that checks stages did their work.
 *
 * The stage's medium was known all along — `kind` is on the stage — and the prompt
 * simply never said it. Remembering to phrase findings per stage cannot be the
 * operator's job: it is a property of the stage, so the harness owns it.
 */
export function correctionMedium(kind: StageKind): string {
  switch (kind) {
    case "planning":
      return "the plan this stage produced";
    case "implementation":
      return "the code this stage wrote";
    case "deployment":
      return "this stage's deployment steps and what it ships";
    case "test":
      return "the tests this stage wrote";
    case "codeReview":
    case "domainReview":
      return "this stage's review findings";
    case "behaviourReview":
      return "the verification checklist this stage wrote";
    case "humanVerification":
      return "this stage's own record of what was verified";
    case "assessment":
      return "this stage's assessment of what is already done";
  }
}

/**
 * What a repaired stage owes about the output it is *not* changing.
 *
 * A review's output is a list, and the runtime reads the standing round's list as the
 * stage's current findings — because a stage corrected once and amended three times
 * holds four complete accounts of itself, and counting all four re-raises criticals a
 * later round resolved. That rule is only safe if the standing round is complete, so
 * the prompt has to oblige what the parser reads: every finding, carried forward with
 * its current status, including the ones this repair did not touch.
 *
 * It sits *against* the narrowing instruction above it and does not contradict it —
 * restating a finding is not re-deriving it. The distinction is stated in as many
 * words because a session told to change nothing else will otherwise report only its
 * delta, which is what a well-behaved correction of any other kind of stage should do.
 *
 * Review stages only. A plan, a deployment or an implementation is corrected in a file
 * that still holds everything the round before it wrote, so the medium carries the
 * unchanged parts on its own and asking for a restatement would be asking a session to
 * re-emit a document it has already edited.
 */
function carryForwardRule(kind: StageKind): string[] {
  if (kind !== "codeReview" && kind !== "domainReview") return [];
  return [
    "Your report replaces the one above it as this stage's findings, so it has to be",
    "complete on its own: list every finding this stage raised, including the ones",
    "this repair does not touch. A finding you leave out is read as one that no longer",
    "stands, and nothing else will raise it again.",
    "",
    "Each one gets one of three statuses, and the third exists because you cannot tell",
    "from this note what the repair touched:",
    "",
    "- OUTSTANDING — you have looked at the code as it now stands and the defect is",
    "  still there. This is a claim about the present, and it is the label that stops",
    "  the route and pays for another repair, so do not use it on the strength of an",
    "  earlier round. Re-read the file the finding names, and re-run the measurement if",
    "  the finding quotes one.",
    "- RESOLVED — you have looked, and it is fixed. Say what you saw.",
    "- CARRIED FORWARD, NOT RE-CHECKED — you have not looked this time. Perfectly",
    "  acceptable, and better than either of the above when you have not done the work.",
    "",
    "Re-reading a file is cheap. A finding labelled outstanding when it was fixed two",
    "hours ago costs a whole repair session, the stages behind it, and an operator",
    "working out which of two stages to believe — so when the two costs are weighed,",
    "check rather than assume.",
    "",
  ];
}

export function correctionPrompt(
  context: StageContext,
  stage: TaskStage,
  finding: string,
  previousReport: string,
): string {
  const medium = correctionMedium(stage.kind);
  return [
    preamble(context, stage),
    "",
    "## This stage has already run. You are fixing one thing in what it produced.",
    "",
    "You are not re-running the stage and not starting again. The work below exists;",
    "something specific about it is wrong, and your job is the smallest change that",
    "makes it right.",
    "",
    "### What is wrong",
    "",
    finding.trim(),
    "",
    "### What this stage reported when it ran",
    "",
    previousReport.trim() || "_It recorded no report._",
    "",
    "### How to do this",
    "",
    `This stage's output is ${medium}, and that is the only thing you are correcting.`,
    "A finding is written about where the problem was *noticed*, which is usually the",
    "code and is not always where this stage works. If it names a defect that a",
    "different stage owns, correct this stage's own output so that stage produces the",
    "right thing — do not do that stage's work here. Work done in the wrong stage is",
    "invisible to everything that checks a stage did its own, and the stage that owns",
    "it will run afterwards against output that never mentioned it.",
    "",
    `Go straight to the part of ${medium} the finding names. Do not re-read the ticket,`,
    "re-derive the approach, or re-check work the finding does not mention — reviews",
    "have already passed the rest of this stage, and changing it invalidates them for",
    "no reason.",
    "",
    ...carryForwardRule(stage.kind),
    "If the fix turns out to need a change of approach rather than a change of code,",
    "do not make it: that is a re-run, and it is a decision for the person who asked",
    `for this. Say so with a line starting exactly "${CORRECTION_DECLINED_MARKER}"`,
    "followed by one sentence naming what would have to change, and then stop. Put",
    "your reasoning in the report below it, at whatever length it needs. Declining",
    "is a correct outcome and it is recorded as one — the route is held for a person",
    "to decide. Describing the problem only in prose is not: without that line this",
    "stage is recorded as fixed, and everything after it is built on the version you",
    "have just said is wrong.",
    "",
    // Added 2 Sep 2026 from a measurement, not a guess. Of 13 stages held on this
    // marker, 3 were emitted to say the *opposite* of what it means: "not needed — this
    // is a straightforward report correction, not a rebuild", "false — I can amend this
    // in place; no rebuild needed. Here's the fix." The runtime read each as "this needs
    // a re-run" and held the route, so a stage that had just offered the fix was stopped
    // as though it had refused. A 23% false-stop rate on the one marker whose whole
    // purpose is to be believed.
    //
    // Closed in the prompt rather than the parser because there is no evidence to read:
    // all three wrote zero files, exactly like the ten genuine declines, so nothing in
    // the activity separates them. Keying a hold on the prose would be the false-stop
    // trade this domain refuses everywhere else.
    "",
    "One thing this line is NOT for: disagreeing that a rebuild is needed. If you can",
    "make the fix here, just make it — you do not need to say anything about rebuilds.",
    `Use "${CORRECTION_DECLINED_MARKER}" only to say the opposite: that you *cannot* do`,
    "this as a targeted change. Emitting it to mean \"no rebuild needed, here is the",
    "fix\" stops the route for a person who then finds the fix already offered.",
    "",
    "Report what you changed and why, in a few lines. If the finding was wrong — the",
    "code already does what it says is missing — say that instead of changing",
    "something to satisfy it.",
  ].join("\n");
}

export const ASSESSED_MARKER = "ASSESSED:";

/**
 * Asks an assessment stage which of the route's stages the existing work already
 * satisfies.
 *
 * The whole point is that it produces *evidence*, not a verdict. The alternative —
 * a human ticking off the stages they believe are done — records work as complete
 * because somebody said so, which is the failure the harness exists to prevent.
 *
 * Stage ids rather than names, because the reply is parsed and matched: a stage
 * renamed between the route file and the pipeline would silently match nothing.
 */
export function assessmentPrompt(context: StageContext, stage: TaskStage): string {
  return `${preamble(context, stage)}

${stage.intent}

Work on this task has already been started, by hand or by an earlier session. Your
job is to find out how far it got — nothing more. Do not write code, do not fix
anything, and do not finish anything you find half-done. A later stage owns that.

Look wherever the work would actually be, which is not always the repository:

- the worktree, and the diff against ${context.baseBranch};
- the environments this work targets, if you have tooling that can read them. Work
  predating source control lives only there — a procedure deployed to DEV years ago
  exists, and no diff will ever show it;
- anything the project's own documentation records about it.

A thing that exists in an environment but not in the repository is **not done**. The
route's job is to bring it under source control and through review, and a stage skipped
because the object already exists somewhere would skip exactly that. Say so in the
evidence — "exists in DEV, absent from the repository" — because that sentence is what
tells the implementing stage what it is actually for.

For every other stage of the route listed above, reply with one line:

"${ASSESSED_MARKER} <stage id> done|not done — what you saw that shows it"

The evidence is the part that matters, and it must be something you observed: an
object that exists, a file that contains a thing, a row that is present or absent.
"Looks complete" is not evidence. If you cannot tell, say "not done" and say why —
a stage run needlessly costs a session, while a stage skipped wrongly costs the
thing it was there to catch.

Judge only whether the work exists, never whether it is good. A stage you mark done
is skipped, so its review never runs; if what you find looks wrong, mark it not done
and say so.`;
}

/**
 * Reads an assessment stage's per-stage conclusions.
 *
 * Tolerant in the same way the plan-step parser is: the marker must start a line, the
 * separator may be any dash, and a line without one keeps its whole tail as evidence
 * rather than being dropped.
 */
export function parseAssessments(
  reply: string,
): { stageId: string; done: boolean; evidence: string }[] {
  const found: { stageId: string; done: boolean; evidence: string }[] = [];
  const seen = new Set<string>();
  // A literal, not a template built from the marker constant. Built that way the
  // escapes collapse — `\S` became "S" and the class `[—\-:]` an out-of-order range —
  // and `new RegExp` threw on construction, which would have failed every assessment
  // reply rather than merely parsing one badly.
  const pattern =
    /^[ \t]*ASSESSED:[ \t]*(\S+)[ \t]+(done|not done)\b[ \t]*[—:-]*[ \t]*(.*)$/gim;
  for (const match of reply.matchAll(pattern)) {
    const stageId = match[1].trim();
    // First mention wins, so a reply that restates the instruction or corrects
    // itself later cannot flip a stage to skipped after the fact.
    if (seen.has(stageId)) continue;
    seen.add(stageId);
    found.push({
      stageId,
      done: match[2].toLowerCase() === "done",
      evidence: match[3].trim(),
    });
  }
  return found;
}

/** The reply without its assessment lines. See `stripVerdict` on the newline collapse. */
export function stripAssessments(reply: string): string {
  return reply
    .replace(/^[ \t]*ASSESSED:[ \t]*.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
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

  for (const raw of unfencedLines(text)) {
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
export function parseChecklistReply(
  text: string,
  /**
   * Scopes the route declared. A tag is only recognised as one when it names one of
   * these — see `splitScopeTag` for why anything else stays in the item's text.
   */
  declaredScopes: readonly string[] = [],
): { text: string; scope?: string }[] {
  if (/^\s*none\s*$/i.test(text)) return [];

  const items: { text: string; scope?: string }[] = [];
  for (const raw of unfencedLines(text)) {
    const line = raw.trim();
    const bullet = /^(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const body = bullet[1].trim();
    // A lone "NONE" bullet means the same as the bare word.
    if (!body || /^none$/i.test(body)) continue;
    const split = splitScopeTag(body, declaredScopes);
    // A bullet that was nothing but a scope tag carries no item.
    if (!split.text) continue;
    items.push(split.scope ? { text: split.text, scope: split.scope } : { text: split.text });
  }
  return items;
}

/**
 * A reply's lines with fenced code blocks removed.
 *
 * Every parser here reads a bulleted or numbered line as a fact, and a fenced block
 * is the one place a reply legitimately contains lines of that shape that are not
 * facts — a split reply quoting a numbered script gains subtasks from its own
 * example, and a checklist quoting a snippet gains items nobody can tick, which then
 * hold a gate. Same guard `parsePlanSteps` and `parseReviewFindings` carry, and for
 * the same reason.
 */
function unfencedLines(text: string): string[] {
  const kept: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:`{3,}|~{3,})/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(raw);
  }
  return kept;
}

function truncateTitle(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return firstSentence.length > 60 ? `${firstSentence.slice(0, 57)}…` : firstSentence;
}
