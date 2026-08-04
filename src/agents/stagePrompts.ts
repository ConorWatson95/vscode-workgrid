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
}

/**
 * Marker a stage uses to ask for information instead of guessing. Recognised by
 * `parseNeedsInfo`, which pauses the route and puts the question to the user.
 */
export const NEEDS_INFO_MARKER = "NEEDS-INFO:";

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
    `Task: ${context.taskName}`,
    context.taskDescription ? `Brief: ${context.taskDescription}` : "",
    `Branch: ${context.branchName} (based on ${context.baseBranch})`,
    `Stage: ${stage.name}`,
    "",
    "You are one stage of a defined workflow and have no memory of earlier stages.",
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
    ...(context.guidance && context.guidance.length > 0
      ? [
          "",
          "The operator has given the following instructions while approving earlier",
          "stages. They override your own judgement and the brief where they conflict:",
          ...context.guidance.map((note) => `- ${note}`),
        ]
      : []),
    ...(context.docsPath ? ["", docsGuidance(context.docsPath)] : []),
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
stage of the workflow, say so at the end rather than doing it.`;

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
