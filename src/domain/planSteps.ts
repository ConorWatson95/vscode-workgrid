/**
 * Per-step accounting for a stage that executes a written plan.
 *
 * The fifth instance of the harness's one recurring failure: something that
 * existed only as prose, or only as a line in a file nobody accounted for.
 *
 * What it cost. A live ticket's plan had a numbered step — "post-deploy data
 * rebuild: reload each file from period 244 onward and rebuild the two KPI
 * elements". The deployment stage shipped the migration, the flag and the
 * procedures, did not do that step, said nothing about it, and **passed**. It
 * surfaced in production as a scorecard tile reading 0.0%, found by hand days
 * later.
 *
 * Why nothing already here caught it:
 *
 * - `verify` would need a post-condition query specific to that ticket. It cannot
 *   generalise, and a route is written once for many tickets.
 * - `DEFERRED` catches work a stage *declines*. This stage did not decline the
 *   step; it simply did not do it.
 * - The plan is a markdown file of numbered steps, and the stage self-reports one
 *   outcome for the whole of it — so a skipped step is indistinguishable from a
 *   completed one.
 *
 * The fix is accounting, not judgement: every numbered step must come back either
 * done or explicitly not done with a reason, and a stage with a step it never
 * mentioned cannot pass.
 *
 * **Step identity comes from the file.** The plan is written by one cold session
 * and executed by another, so nothing held in a session can identify a step —
 * only the numbers in the document both of them read.
 *
 * Pure and vscode-free: the file's contents arrive as a string.
 */

/** One numbered step of a plan, as the plan file numbers it. */
export interface PlanStep {
  number: number;
  /** The step's own heading text, used to name it in prompts and reports. */
  title: string;
}

/** What a stage said about one step. */
export type StepAccountState = "done" | "not-done";

/** A stage's account of one step, parsed out of its reply. */
export interface StepAccount {
  number: number;
  state: StepAccountState;
  /** What it did, or why it did not. The stage's own words. */
  note?: string;
}

/** Longest step title kept; they are headings, and a paragraph is not one. */
const MAX_TITLE_CHARS = 120;

/**
 * The numbered steps of a plan document.
 *
 * Two shapes are recognised, because both are how plans actually get written:
 * numbered headings (`## 4. Post-deploy data rebuild`) and a top-level numbered
 * list. Headings win outright when the document has any — a plan written with
 * numbered headings also contains numbered lists *inside* those steps, and
 * treating those as steps would demand accounting for every sub-bullet.
 *
 * Fenced code is skipped: a plan that quotes a numbered script would otherwise
 * gain steps from its own examples.
 *
 * The first occurrence of a number wins. A document that repeats "4." is
 * describing one step twice, and two records for it would be unaccountable by
 * construction — the reply can only account for step 4 once.
 */
export function parsePlanSteps(markdown: string): PlanStep[] {
  const headings: PlanStep[] = [];
  const listItems: PlanStep[] = [];
  let inFence = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // "## 4. Title", "### Step 4 — Title", "## 4) Title"
    const heading = /^#{1,6}\s+(?:step\s*)?(\d{1,3})\s*[.):\]]?[ \t]*[-–—:]?[ \t]*(.*)$/i.exec(
      line,
    );
    if (heading) {
      push(headings, heading[1], heading[2]);
      continue;
    }

    // A top-level numbered item only. An indented one is a sub-step of the item
    // above it, and the plan's numbering restarts inside each.
    const item = /^(\d{1,3})[.)]\s+(.+)$/.exec(line);
    if (item) push(listItems, item[1], item[2]);
  }

  return headings.length > 0 ? headings : listItems;
}

function push(into: PlanStep[], rawNumber: string, rawTitle: string): void {
  const number = Number(rawNumber);
  if (!Number.isFinite(number) || number <= 0) return;
  if (into.some((step) => step.number === number)) return;
  const title = rawTitle.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS);
  into.push({ number, title: title || `Step ${number}` });
}

/**
 * How a stage accounts for one step of the plan it was given.
 *
 * A marker line, like every other fact the harness reads out of a reply, and for
 * the same reason: the stage already writes about what it did, in prose that
 * nothing could act on.
 */
export const STEP_MARKER = "STEP";

/**
 * Every step account in a reply.
 *
 * Anchored to the start of a line and requiring the number, so the word in prose
 * — "the next step is the rebuild" — is not read as an account. The last account
 * for a number wins: a stage that restates the instruction, or revises its own
 * answer after doing more work, means the later line.
 *
 * A state that is neither word is read as **not done**. Being unable to classify a
 * stage's own account of a step is not a reason to record the step as complete;
 * every ambiguity here has to fall on the side that holds the route.
 */
export function parseStepAccounts(reply: string): StepAccount[] {
  const byNumber = new Map<number, StepAccount>();
  const pattern = /^[ \t]*STEP[ \t]+(\d{1,3})[ \t]*:[ \t]*([^\n—–-]*)(?:[—–-][ \t]*(.*))?$/gim;

  for (const match of reply.matchAll(pattern)) {
    const number = Number(match[1]);
    if (!Number.isFinite(number)) continue;
    const word = (match[2] ?? "").trim().toLowerCase();
    const note = (match[3] ?? "").trim();
    const state: StepAccountState = /^done\b/.test(word) ? "done" : "not-done";
    byNumber.set(number, {
      number,
      state,
      // A "not done" with no reason keeps the word itself, so the record says
      // something rather than presenting an empty explanation.
      note: note || (state === "not-done" ? word || undefined : undefined),
    });
  }

  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** The reply without its step lines, which are protocol rather than report. */
export function stripStepAccounts(reply: string): string {
  return reply
    .replace(/^[ \t]*STEP[ \t]+\d{1,3}[ \t]*:[ \t]*.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Steps the reply said nothing about.
 *
 * The whole mechanism in one function: a step nobody mentioned is the failure
 * mode, and it reads identically to a completed one in any account the stage
 * gives of itself.
 */
export function unaccountedSteps(
  steps: readonly PlanStep[],
  accounts: readonly StepAccount[],
): PlanStep[] {
  const seen = new Set(accounts.map((account) => account.number));
  return steps.filter((step) => !seen.has(step.number));
}

/**
 * Tells a stage which steps it must account for, and how.
 *
 * The list is restated in the prompt rather than left to the file. The stage does
 * read the file, but the numbers it must answer for are the ones the harness
 * parsed — so a stage that renumbers, merges or overlooks a step in its own
 * reading still gets asked about every step the engine is holding.
 */
export function planStepInstruction(
  planPath: string,
  steps: readonly PlanStep[],
): string {
  if (steps.length === 0) return "";
  return `

This stage executes the plan in ${planPath}. Read it. It has ${steps.length}
numbered step(s), and you must account for every one of them:

${steps.map((step) => `  ${step.number}. ${step.title}`).join("\n")}

End your reply with one line per step, exactly in this form:

${STEP_MARKER} <number>: done — <what you did, in one sentence>
${STEP_MARKER} <number>: not done — <why not, and who or what it needs>

Every number above must appear. A step you did not do is a correct answer and is
recorded as one — the workflow follows it up and holds the next stage that ships
until someone owns it. A step you simply do not mention holds this stage instead,
because a step nobody accounted for is indistinguishable from one that was
skipped, and that has already reached production once. Do not claim a step you
did not verify.`;
}
