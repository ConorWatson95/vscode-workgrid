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
    `ticket reference — do NOT guess and do NOT proceed. Reply with exactly`,
    `"${NEEDS_INFO_MARKER}" followed by your specific questions, and nothing else.`,
    `The work will pause and a human will answer. First check whether the answer is`,
    `already available to you: read the code, and use any ticket tooling this`,
    `repository provides. Only ask for what you genuinely cannot find.`,
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
  ]
    .filter(Boolean)
    .join("\n");
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
export function parseNeedsInfo(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) =>
    line.trimStart().toUpperCase().startsWith(NEEDS_INFO_MARKER),
  );
  if (index === -1) return undefined;

  const first = lines[index].trimStart().slice(NEEDS_INFO_MARKER.length).trim();
  const rest = lines.slice(index + 1).join("\n").trim();
  const question = [first, rest].filter(Boolean).join("\n").trim();

  // A marker with nothing after it is still a request to pause; say something
  // useful rather than showing an empty dialog.
  return question || "The stage asked for more information but did not say what.";
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
