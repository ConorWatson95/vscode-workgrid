/**
 * Pipeline state: the *live* half of the harness. A pipeline is a route
 * instantiated against one task — same stage order, plus the subtasks a
 * planning agent produced and the outcome of each.
 *
 * Everything here is plain JSON so it round-trips through the task repository
 * untouched. All transitions live in ./pipelineEngine and are pure.
 */

import { ChecklistAudience, StageKind } from "./taskRoute";
import { InterventionRecord } from "./interventions";
import { PipelineExperiment } from "./pipelineExperiment";

export type TaskStageStatus =
  | "pending"
  | "active"
  /** Every subtask resolved, held at a human gate. */
  | "awaiting-approval"
  | "passed"
  | "failed"
  | "skipped";

export type SubtaskStatus = "pending" | "active" | "done" | "failed" | "skipped";

/**
 * One unit of agent work. Subtasks are stages-within-a-worktree: they share the
 * parent task's worktree and branch, and each gets its own agent session. That
 * session boundary is the point — a subtask starts with a clean context and a
 * single objective instead of inheriting everything before it.
 */
export interface Subtask {
  /** Unique within the pipeline. */
  id: string;
  title: string;
  /** The prompt handed to the agent session for this subtask. */
  prompt: string;
  /** Optional slash-command to invoke instead of sending `prompt` as text. */
  workflow?: string;
  status: SubtaskStatus;
  /** Agent session that ran (or is running) this subtask, once known. */
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Set when status is "failed" — why it failed, for display and retry. */
  failureReason?: string;
  /**
   * What the agent said at the end, kept verbatim.
   *
   * A stage session is otherwise invisible: the reply was parsed for a marker and
   * then discarded, so a preview that produced pages of output left nothing to
   * look at and had to be run again by hand to be seen.
   */
  reply?: string;
  /** What the subtask actually did: tools, commands, files, output. */
  activity?: SubtaskActivity;
  /**
   * Set when this subtask is a repair of the stage rather than part of its plan.
   *
   * Kept so a stage that took three goes is distinguishable from one split into
   * three units, and so the correction session can be given a different prompt —
   * it is handed the stage's own previous report and told what is wrong with it,
   * which is the entire reason a correction costs a fraction of a re-run.
   */
  correction?: {
    finding: string;
    at: string;
    undo?: CorrectionUndo;
    /**
     * Set when this is an *amendment* — a stage bringing its own output into line
     * because the stage it was built on was corrected — rather than a correction to
     * this stage's own work.
     *
     * Kept apart because the two repeats mean opposite things. Three corrections is a
     * stage that got its own work wrong three times; three amendments is a stage that
     * was right each time and had the ground moved under it. A ledger that conflated
     * them would send the next investigation at exactly the wrong stage. It is also
     * what lets `undoCorrection` find the amendments one correction caused.
     *
     * `findings` are the upstream findings this amendment answers, raw and in order —
     * more than one when it absorbed corrections of the same stage that were appended
     * while it was still pending. Kept apart from `finding`, which is the composed
     * note, because a note cannot be merged with another without parsing prose back
     * into the parts it was rendered from. Absent on amendments recorded before
     * coalescing existed, which is why every reader treats it as optional.
     */
    upstream?: { stageId: string; stageName: string; findings?: string[] };
  };
}

/**
 * The stage settlement a correction cleared, kept so it can be put back.
 *
 * A correction undoes its stage's own conclusion — status, verdict, verification,
 * a `BLOCKED:` reason — because all of it was about the version being corrected.
 * That is right while the correction stands, and unrecoverable once it does not:
 * a finding that turns out to be wrong left a stage that had passed sitting
 * `pending` with no record it ever had, so withdrawing the finding still cost the
 * re-run the correction existed to avoid.
 *
 * Snapshotted rather than re-derived because none of it is derivable. A verdict is
 * what a reviewing session said, and the session is gone.
 *
 * Only the corrected stage's own settlement. The stages *after* it were re-opened
 * and their replies cleared, and no snapshot here can bring those back — see
 * `undoCorrection`, which says so rather than implying otherwise.
 */
export interface CorrectionUndo {
  status: TaskStageStatus;
  finishedAt?: string;
  verdict?: "pass" | "block";
  verification?: { command: string; exitCode: number; at: string };
  blocked?: string;
}

/**
 * A record of what one subtask did.
 *
 * Deliberately a summary rather than a transcript: this lives in the task state
 * file, which is read and rewritten whole on every update, so an unbounded
 * transcript here would make every later write more expensive. See
 * `agents/stageActivity.ts` for what is kept and why.
 */
export interface SubtaskActivity {
  /** Tool name to call count. */
  toolCounts?: Record<string, number>;
  /** Shell commands run, verbatim, so a wrong flag is visible afterwards. */
  commands?: string[];
  pathsWritten?: string[];
  pathsRead?: string[];
  /** Command output, capped. */
  output?: string;

  /**
   * Error output belonging to no tool call — the CLI's own complaints.
   *
   * Kept separately because it is the only evidence a session that failed before
   * running anything leaves behind. Without it such a subtask recorded no tools,
   * no commands and no reply, and its report read as though the stage had never
   * started.
   */
  errors?: string[];

  /**
   * What this subtask's session cost, in USD.
   *
   * The CLI reports it, and it was logged and then dropped — so a route's cost
   * was visible while it ran and unattributable afterwards. Persisted because
   * the questions being asked of the harness are comparative: whether a cheaper
   * model on a stage, a narrower tool set, or a handover brief that prevents
   * rediscovery actually costs less than what it replaces. None of those can be
   * answered from a number that no longer exists once the stage ends.
   */
  costUsd?: number;
  /** Cumulative tokens for the session, once it reported a result. */
  tokens?: SessionTokenTotals;

  /**
   * Of this subtask's span, how long it sat blocked on a human via `ask_user`.
   *
   * `ask_user` returns its answer into the waiting turn, which is the whole reason it
   * is cheaper than `NEEDS-INFO` — and the side effect is that the operator's
   * thinking time is recorded inside `startedAt`/`finishedAt` as though the model
   * were working. A real route reported 4% idle while its 32-minute implementation
   * stage had asked two questions, so supervision was being counted as execution:
   * the one number the harness exists to move, folded into the one it cannot.
   *
   * Absent means **unmeasured, not zero** — anything that ran before this existed
   * records nothing — which is why `stageUsage` reports it beside the elapsed time
   * rather than only subtracting it. See `domain/humanWait.ts`.
   */
  blockedOnHumanMs?: number;

  /**
   * The model the CLI actually resolved for this session, from its init event.
   *
   * Recorded next to the request rather than instead of it, because they can
   * differ: an organisational policy that disallows a model falls back to the
   * parent's, and the CLI reports the substitution without failing. A stage
   * comparison — is haiku good enough here, did the cheaper model cost more in
   * retries — is measuring nothing if the recorded model is the one that was
   * asked for rather than the one that ran.
   */
  actualModel?: string;
}

/**
 * Cumulative token counts for one agent session.
 *
 * Four numbers rather than one total because they price differently and answer
 * different questions: `cacheRead` is nearly free and is the whole argument for a
 * stable prompt preamble, while `input` is what a rediscovering session actually
 * spends. Collapsing them to a total hides the effect being measured.
 */
export interface SessionTokenTotals {
  /** Fresh (uncached) input tokens. */
  input: number;
  output: number;
  /** Input served from the prompt cache. */
  cacheRead: number;
  /** Input written *into* the cache, which is charged at a premium. */
  cacheCreation: number;
}

/**
 * Something the operator said when approving a stage.
 *
 * The gate is the moment a human has just read what a stage produced and knows
 * something the route does not — "deploy only this project", "skip the Motability
 * variant". Without somewhere to put it, acting on it meant editing the brief or
 * re-running a stage, so the knowledge was either lost or expensive.
 */
export interface GuidanceNote {
  id: string;
  /** Stage that was being approved, so the note can be attributed. */
  stageId: string;
  stageName: string;
  text: string;
  at: string;
  /**
   * Who the note is for.
   *
   * `route` — every stage from here on. What an approval note has always meant: a
   * human has just read a stage's output and knows something the route does not.
   *
   * `stage` — the stage it names, and only while that stage is being redone. What a
   * send-back's findings and a re-run's reason actually are: instructions about one
   * stage's output, correct exactly once.
   *
   * The distinction was missing, and everything was `route`. So a send-back note aimed
   * at an implementation stage reached a DEV deployment preview two stages later,
   * ranked above its brief, describing defects that had been fixed before it started —
   * that stage spent a paragraph of its report explaining it was not going to
   * re-litigate them, which is the good outcome. The bad one arrived the same day: a
   * correction's finding about a discarded build was handed to the stage's own re-run,
   * which stopped to ask three questions about an exception that no longer existed.
   *
   * Optional, and absent means `route`: existing pipelines keep exactly the behaviour
   * they had, and only notes written by a build that knows the difference are narrowed.
   */
  scope?: "route" | "stage";
}

/**
 * What one stage concluded, for the stages after it.
 *
 * Capped hard: this is prompt text every later stage pays for, and an uncapped
 * one would grow the context of every subsequent session — the exact cost the
 * fresh-session design exists to avoid.
 */
export interface StageHandoff {
  stageId: string;
  stageName: string;
  /** Trimmed to `MAX_HANDOFF_CHARS`, with the truncation announced. */
  text: string;
  at: string;
}

/** Per-stage ceiling on carried-forward text. */
export const MAX_HANDOFF_CHARS = 1500;

/** Normalises and caps a handoff's text. */
export function truncateHandoff(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_HANDOFF_CHARS) return trimmed;
  // Announced, so a later stage knows it is reading a summary and can go and look
  // rather than assuming this is everything.
  return `${trimmed.slice(0, MAX_HANDOFF_CHARS)}\n…(truncated; read the files it names for the rest)`;
}

/**
 * Work a stage declined because it judged it to belong to a different stage.
 *
 * Every stage is told to stay within its objective and say so rather than reach
 * outside it, which is right — but the saying-so was prose at the end of a reply,
 * and nothing read it. So work that belonged to *no* stage was declined by each
 * one in turn and discovered only where it finally mattered: a live publish that
 * halted on a structure nobody had created, several stages after the first agent
 * noticed it was missing.
 *
 * Recorded so the engine can hold a deployment until each one has an owner. The
 * text is the stage's own words, because the value is in what it actually saw.
 */
export interface DeferralItem {
  id: string;
  /** What was declined, as the stage described it. */
  text: string;
  raisedByStage: string;
  raisedByStageName: string;
  at: string;
  /**
   * Set when a human has settled it — either the work has an owner now, or it
   * genuinely needed nobody. Resolved rather than deleted so the record of what
   * was noticed, and what was decided about it, survives in the report.
   */
  resolved?: boolean;
  /** Why it was settled. Required in practice: "resolved" alone explains nothing. */
  resolution?: string;
  resolvedAt?: string;
}

/**
 * One stage of the route, as an assessment stage found it.
 *
 * `done` means the work appears already present. It never means the stage passed:
 * the evidence is a reading of what exists, not a run, and the two must not be
 * recorded the same way.
 */
export interface StageAssessment {
  /** The stage this is about. */
  stageId: string;
  done: boolean;
  /**
   * What the assessment saw, in its own words.
   *
   * Required in practice for the same reason settling a deferral requires a
   * sentence: "done" alone is the claim this whole mechanism exists to replace.
   */
  evidence: string;
}

/** Longest deferral text kept. They are one-liners; anything longer is a reply. */
export const MAX_DEFERRAL_CHARS = 400;

/**
 * One numbered step of a plan a stage executes, and the stage's account of it.
 *
 * `"unaccounted"` is the state that matters and the reason this exists: a stage
 * that executed a written plan self-reported one outcome for the whole document,
 * so a step it silently skipped looked exactly like a step it completed. One such
 * step — a post-deploy data rebuild — reached production as a scorecard reading
 * 0.0%. See `domain/planSteps.ts`.
 */
export interface PlanStepRecord {
  /** As the plan file numbers it; step identity comes from the document. */
  number: number;
  title: string;
  status: "unaccounted" | "done" | "not-done";
  /** What the stage did, or why it did not. Its own words. */
  note?: string;
  /** When the stage accounted for it. */
  at?: string;
}

/**
 * One thing a human must verify. Produced by behaviour-review stages and
 * consumed at the human-verification gate — this is the evidence a task must
 * present before it can be called complete.
 */
export interface ChecklistItem {
  id: string;
  /** What to exercise, and what would indicate a regression. */
  text: string;
  /**
   * What kind of item this is. Absent means `"verify"`, so items recorded before this
   * existed keep their meaning without a migration.
   *
   * `"action"` is a step only the operator can take — a pull request to open, a
   * registration in a third party's console. It differs from a verification in two
   * ways that matter: it gates the stage that raised it whatever that stage's kind,
   * and bulk-ticking it would be a false statement rather than a judgement call.
   */
  kind?: "verify" | "action";
  /**
   * Which verification gate should read this item, by the gate's declared
   * `checklistScope`.
   *
   * Exists because one pooled list cannot express two verifications in two
   * environments. On a real route the same change has to be exercised twice for
   * different reasons — locally against the DEV database, which asks whether the
   * change *behaves*, and then on the deployed DEV site, which asks whether it works
   * where people will see it and catches configuration, permissions and the
   * deployment itself. `outstandingChecklist` pooled every item pipeline-wide, so the
   * first gate absorbed all of them and the second had nothing left to ask for.
   *
   * Absent means unscoped, which is **not** the same as "no gate": see
   * `domain/checklistScope.ts`. An item must be verified somewhere, so an unscoped
   * one is assigned rather than dropped.
   */
  scope?: string;
  checked: boolean;
  /** Stage that raised it, so the gate can explain where each item came from. */
  raisedByStage: string;
  /** Optional tester note, e.g. what they actually observed. */
  note?: string;
  checkedAt?: string;
}

export interface TaskStage {
  /** Mirrors RouteStageDefinition.id. */
  id: string;
  name: string;
  kind: StageKind;
  status: TaskStageStatus;
  /** Copied from the route so a persisted pipeline is self-describing. */
  intent: string;
  splittable: boolean;
  requiresApproval: boolean;
  /**
   * Set on stages that produce or consume verification items. A behaviour
   * review writes them; the human-verification gate collects every outstanding
   * one and cannot be approved while any remain unchecked.
   */
  checklist?: ChecklistItem[];
  /**
   * What this verification gate is responsible for confirming, as a short label —
   * `"local"`, `"dev-site"`. Copied from the route so a persisted pipeline stays
   * self-describing.
   *
   * Only meaningful on a `humanVerification` stage. When no gate in the pipeline
   * declares one, checklist behaviour is exactly what it was before scopes existed:
   * the first unresolved gate answers for every item. See `domain/checklistScope.ts`.
   */
  checklistScope?: string;
  /**
   * Who answers this gate's items, copied from the route so a persisted pipeline
   * stays self-describing. Absent means `"self"`.
   *
   * Only meaningful on a `humanVerification` stage. A gate answered by others means
   * the task has left the operator until feedback arrives, which is a different state
   * from waiting on them — see `RouteStageDefinition.checklistAudience`.
   */
  checklistAudience?: ChecklistAudience;
  /**
   * This stage promotes by pull request and owes its URL in its report, copied from
   * the route so a persisted pipeline stays self-describing.
   *
   * See `RouteStageDefinition.requiresPullRequest` and
   * `domain/pullRequestEvidence.ts`.
   */
  requiresPullRequest?: boolean;
  /** Why this stage exists, when it was appended by a rule rather than a route. */
  addedByRule?: string;
  /**
   * What the rule that added this stage matched on, copied from the rule so a
   * persisted pipeline stays self-describing.
   *
   * The rule set lives in project config and is read against git's changed paths;
   * by the time a correction cascades, nothing in the pipeline knew what a
   * rule-added review was *about*. Persisting the pattern is what lets
   * `domain/amendmentReach.ts` tell a review a correction could have invalidated
   * from one it demonstrably could not — a Razor `@using` fix does not reach the
   * SQL migration review, and paying a session to have it say so is the 91% of
   * amendments that changed nothing.
   *
   * Absent on every stage recorded before this existed, and on every route stage,
   * which both mean the same thing: nothing is known, so nothing is narrowed.
   */
  rulePaths?: { pathPattern: string; exceptPattern?: string };
  /**
   * Model for this stage's sessions, copied from the route so a persisted
   * pipeline stays self-describing. Undefined means the configured default.
   */
  model?: string;
  /**
   * Earlier stages this stage's findings may be sent back to, copied from the
   * route. Empty or absent means the stage cannot send work back at all, which is
   * the default — see `RouteStageDefinition.sendBackTo`.
   */
  sendBackTo?: string[];
  /** Carry this stage's conclusion to later stages; see the route definition. */
  handoff?: boolean;
  /**
   * This stage may move the worktree to another branch; see the route definition.
   * Snapshotted at creation, so a stage that ran keeps the permission it ran with.
   */
  mayChangeBranch?: boolean;
  /**
   * Plan document this stage executes, relative to the worktree; see the route
   * definition. Refreshed for a stage that has not started, like `verify`.
   */
  planFile?: string;
  /**
   * Every numbered step of `planFile`, and what this stage said about each.
   *
   * Held on the stage rather than the pipeline because the steps belong to the run:
   * re-opening the stage discards its accounts along with everything else that run
   * produced, which is right — the next run has to account for them again.
   */
  planSteps?: PlanStepRecord[];
  /**
   * Command whose exit code decides this stage's outcome; see the route definition.
   * Refreshed for a stage that has not started, like `intent`, so correcting a check
   * does not require a new task.
   */
  verify?: string;
  /**
   * The check that actually ran, and what it returned.
   *
   * Separate from `verify` because a declaration is not evidence: a runner built
   * without a verifier, or a stage that failed before its last subtask, leaves
   * `verify` set and nothing run. The report said "verified by" on the strength of
   * the declaration alone, which is precisely the claim this pair exists to make
   * checkable — see `domain/stageEvidence.ts`.
   */
  verification?: { command: string; exitCode: number; at: string };
  /**
   * What an assessment stage concluded about each stage of the route.
   *
   * Held on the assessing stage, not on the stages assessed, for the same reason
   * plan-step accounts are held on the stage that ran: re-opening the assessment
   * discards its conclusions along with everything else that run produced, which is
   * right — the next run has to look again.
   */
  assessments?: StageAssessment[];
  /**
   * Why this stage was skipped, when something other than a person skipped it.
   *
   * An assessed stage is recorded as **skipped**, never passed, and this is what
   * stops that being indistinguishable from a human stepping past it. A stage that
   * ran has a report; this has an agent's reading of a diff, and the record has to
   * say which of the two it is.
   */
  skipReason?: string;
  /**
   * MCP servers this stage cannot run without; see the route definition. Refreshed
   * for a stage that has not started, like `verify` — a stage that already ran keeps
   * what it ran with, so the record of why it failed stays true.
   */
  requiredMcpServers?: readonly string[];
  /**
   * What a review stage concluded, in its own words: `block` means it said the work
   * may not proceed.
   *
   * Stored because the verdict line is stripped out of the reply before anyone
   * reads it — a report ending in a bare marker is machinery leaking into a
   * document about stored procedures. Absent means the review stated nothing, which
   * is not the same as `pass`: the route falls back to reading the findings.
   */
  verdict?: "pass" | "block";
  /**
   * Why this stage did not do its work, when it said so with `BLOCKED:`.
   *
   * Persisted for the reason `verdict` is: a stage held for approval with nothing on
   * screen explaining why is how a blocking review came to look like a clean one. The
   * reason previously lived in a transient step line and a log entry, so reopening the
   * window left a held stage and no account of what was missing.
   */
  blocked?: string;
  /**
   * Empty on a splittable stage means "not yet planned". Non-splittable stages
   * are created with exactly one synthesized subtask, so every runnable stage
   * has a uniform shape.
   */
  subtasks: Subtask[];
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskPipeline {
  /** Route this pipeline was instantiated from. */
  routeId: string;
  /**
   * The route's label at creation time. Stored rather than looked up because a
   * route may be defined by the project and later renamed or removed; a
   * persisted pipeline must stay readable regardless.
   */
  routeLabel?: string;
  stages: TaskStage[];
  /** Stage currently active or awaiting approval; absent when at rest. */
  currentStage?: string;
  /**
   * A stage's outstanding question, held until it is answered.
   *
   * Persisted rather than shown and forgotten. A question is the one thing in a
   * route that cannot be recovered by re-reading state: the session that asked
   * it is gone, so a dialog dismissed by accident used to mean re-running the
   * stage just to see what it wanted. It also has to survive several tasks
   * asking at once, which a modal cannot.
   */
  pendingQuestion?: PendingQuestion;
  /**
   * Tool calls the permission layer refused, held until dealt with.
   *
   * Persisted for the same reason questions are: a notification is transient and
   * several tasks produce a pile of them, so dismissing one lost the only record
   * of what was refused and which rule would fix it.
   */
  pendingDenials?: PendingDenials;
  /**
   * What the operator told the route while approving stages, oldest first.
   *
   * Cumulative and handed to every later stage, because guidance given at one gate
   * is usually about the work that follows — "deploy only this project" has to
   * survive past the next stage to be worth anything.
   */
  guidance?: GuidanceNote[];
  /**
   * What earlier stages concluded, carried forward to later ones.
   *
   * The answer to the harness's central cost: subtask-per-session means every
   * stage starts cold, so each one re-derived what the last had just worked out —
   * re-reading the same files, re-querying the same objects, re-deciding the same
   * layering. Independence is what the fresh session buys and is worth keeping;
   * amnesia is not, and this separates the two.
   *
   * Bounded and opt-in per stage (`RouteStageDefinition.handoff`), because the
   * whole point of a fresh session is a small context, and carrying every stage's
   * full reply forward would rebuild the long conversation the harness exists to
   * avoid.
   */
  handoffs?: StageHandoff[];
  /**
   * Work stages declined as belonging elsewhere, oldest first.
   *
   * Accumulated across the whole route rather than held on the stage that raised
   * it, for the same reason the checklist is: the stage that notices is rarely the
   * stage that should act, and an item held on the noticer is invisible to the
   * gate that ought to care.
   */
  deferrals?: DeferralItem[];
  /**
   * Every moment a human had to act on this route, in order.
   *
   * The one measure of the harness's actual goal that nothing else records.
   * Cost, tokens and stage latency all fall out of what a run already persists;
   * supervision does not — approving, answering, granting a permission and
   * settling a deferral are four different records in four different places, and
   * the number that matters is their sum per task. See `domain/interventions.ts`.
   */
  interventions?: InterventionRecord[];
  /**
   * Which side of a comparison this run is on; see `domain/pipelineExperiment.ts`.
   *
   * Persisted on the pipeline rather than held as a setting because a comparison is
   * only worth anything if each run carries a durable record of the conditions it
   * ran under. Two finished tasks with different totals say nothing at all unless
   * something says which one had handoffs withheld.
   */
  experiment?: PipelineExperiment;
  /**
   * What runs that were thrown away had already cost.
   *
   * Re-opening a stage clears `reply` and `activity` on its subtasks, which is right
   * — a report showing output from a discarded run is worse than showing none — but
   * cost lives in `activity`, so every re-run also erased the record of what the
   * previous one cost. A task sent back six times reported the price of its last
   * attempt and looked calm, which is the opposite of what the operator was
   * experiencing, and left the harness unable to measure the one thing it was
   * making expensive.
   *
   * Kept as entries rather than a running total for the same reason interventions
   * are: "$40 discarded" does not distinguish one costly stage re-run twice from a
   * route that churns everywhere, and those have opposite fixes.
   */
  discarded?: DiscardedRun[];
}

/** One stage's runs, discarded by a re-open, and what they had cost. */
export interface DiscardedRun {
  stageId: string;
  stageName: string;
  /** When the run was discarded. */
  at: string;
  /** Why it was discarded — "sent back from X", "re-run by hand". */
  reason?: string;
  costUsd?: number;
  tokens?: SessionTokenTotals;
  elapsedMs?: number;
  /** Sessions the discarded run had used, whether or not they reported cost. */
  sessions: number;
  /**
   * True when this stage was thrown away only because an earlier one changed.
   *
   * The distinction the ledger was missing, and the one that decides whether
   * re-run cost is worth engineering against: a stage discarded because its own
   * output was wrong is work that genuinely had to be done again, while one
   * discarded for sitting downstream of that stage may have been perfectly good.
   * Summed together they say a route is expensive; kept apart they say whether the
   * expense is the route invalidating in proportion to what actually changed.
   *
   * Absent means the target itself — a plain re-run of one stage records no
   * collateral, so absence must not read as "unknown".
   */
  collateral?: boolean;
}

/** Refusals from one stage, waiting on a decision. */
export interface PendingDenials {
  stageId: string;
  stageName: string;
  subtaskId: string;
  refusedAt: string;
  items: DenialItem[];
}

/** One refused call, and the rule that would permit it. */
export interface DenialItem {
  id: string;
  /** Tool that was refused, e.g. "PowerShell". */
  tool: string;
  command?: string;
  /** The permission layer's own words. */
  reason: string;
  /** How many times the agent retried this same call. */
  attempts: number;
  /** Suggested `permissions.allow` entry, when one could be derived. */
  rule?: string;
  /** Set once the rule has been written, so the panel shows what is left. */
  granted?: boolean;
}

/**
 * A stage waiting on answers from a human.
 *
 * Holds the questions as separate items rather than one block of text. A stage
 * that needs three things asks for three things, and pairing each answer with
 * the question it belongs to is what lets the brief record them unambiguously —
 * a single field for five questions produces one answer that addresses whichever
 * the user happened to read.
 */
export interface PendingQuestion {
  stageId: string;
  stageName: string;
  subtaskId: string;
  askedAt: string;
  items: QuestionItem[];
  /**
   * Background the stage offered about all of the questions, shown once.
   *
   * The questions themselves are kept short by telling the model to put its
   * findings here, so this is where the reasoning it would otherwise have written
   * into every question ends up.
   */
  context?: string;
  /**
   * Set when an agent is **blocked on this question right now**, waiting on the
   * `ask_user` tool.
   *
   * The difference it makes: answering a live question hands the answer straight
   * back to the waiting session, which continues mid-turn with everything it had
   * worked out. Answering a question without one enriches the brief and the
   * subtask runs again from the beginning.
   *
   * Persisted with the rest, but only meaningful while that CLI process lives —
   * so a stale one is expected after a reload and callers must treat "no longer
   * waiting" as normal rather than an error.
   */
  liveCallId?: string;
}

/** One question and, once given, its answer. */
export interface QuestionItem {
  id: string;
  text: string;
  answer?: string;
}

/**
 * Upgrades pipelines persisted by earlier versions, which stored only
 * `{ name, status }` stages and no routeId. Such records predate routes, so
 * they are treated as an unnamed ad-hoc route and given the fields the engine
 * needs. Returns undefined for absent input so callers can pass through.
 */
export function normalizePipeline(
  stored: unknown,
): TaskPipeline | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const raw = stored as Partial<TaskPipeline> & { stages?: unknown };
  if (!Array.isArray(raw.stages)) return undefined;

  const stages: TaskStage[] = raw.stages.map((entry, index) => {
    const stage = (entry ?? {}) as Partial<TaskStage> & { name?: string };
    const name = stage.name ?? `Stage ${index + 1}`;
    return {
      // Spread first, then default. Listing the fields exhaustively is what this
      // used to do, and every field added since — verify, verdict, blocked,
      // mayChangeBranch, and now the plan-step accounts — was silently dropped on
      // the next read, because this runs on every load of the state file. That
      // turned each hold into one that a window reload switched off.
      ...stage,
      id: stage.id ?? `stage-${index + 1}`,
      name,
      // Records predating stage kinds described implementation work.
      kind: stage.kind ?? "implementation",
      status: stage.status ?? "pending",
      intent: stage.intent ?? name,
      splittable: stage.splittable ?? false,
      requiresApproval: stage.requiresApproval ?? false,
      checklist: Array.isArray(stage.checklist) ? stage.checklist : undefined,
      addedByRule: stage.addedByRule,
      model: stage.model,
      handoff: stage.handoff === true ? true : undefined,
      sendBackTo: Array.isArray(stage.sendBackTo)
        ? stage.sendBackTo.filter((id): id is string => typeof id === "string")
        : undefined,
      subtasks: Array.isArray(stage.subtasks) ? stage.subtasks : [],
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
    };
  });

  return {
    // Spread for the same reason the stages are: `deferrals` was absent from this
    // list, so the items holding a deployment vanished on reload.
    ...raw,
    routeId: raw.routeId ?? "ad-hoc",
    routeLabel: raw.routeLabel,
    stages,
    currentStage: raw.currentStage,
    pendingQuestion: normalizeQuestion(raw.pendingQuestion),
    pendingDenials: normalizeDenials(raw.pendingDenials),
    guidance: normalizeGuidance(raw.guidance),
    handoffs: normalizeHandoffs(raw.handoffs),
  };
}

function normalizeHandoffs(stored: unknown): StageHandoff[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const handoffs = stored
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      stageId: String(entry.stageId ?? ""),
      stageName: String(entry.stageName ?? entry.stageId ?? "Stage"),
      text: truncateHandoff(String(entry.text ?? "")),
      at: String(entry.at ?? ""),
    }))
    .filter((handoff) => handoff.stageId && handoff.text);
  return handoffs.length > 0 ? handoffs : undefined;
}

/**
 * Keeps stored approval notes, dropping any that lost their text.
 *
 * Returns undefined rather than an empty array so a pipeline that never had
 * guidance round-trips unchanged.
 */
function normalizeGuidance(stored: unknown): GuidanceNote[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const notes = stored
    .filter(
      (note): note is GuidanceNote =>
        Boolean(note) && typeof note.text === "string" && note.text.trim().length > 0,
    )
    .map((note, index) => ({
      id: note.id ?? `g${index + 1}`,
      stageId: note.stageId ?? "",
      stageName: note.stageName ?? note.stageId ?? "",
      text: note.text.trim(),
      at: note.at ?? "",
      // Only a value we recognise survives a round trip. Anything else would reach
      // the delivery filter as neither scope and be silently dropped from every
      // stage, which is worse than the over-delivery this narrows.
      ...(note.scope === "stage" || note.scope === "route" ? { scope: note.scope } : {}),
    }));
  return notes.length > 0 ? notes : undefined;
}

/** Keeps stored refusals only when there is something actionable left. */
function normalizeDenials(stored: unknown): PendingDenials | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const d = stored as Partial<PendingDenials>;
  if (!d.stageId || !d.subtaskId || !Array.isArray(d.items)) return undefined;

  const items: DenialItem[] = d.items
    .filter((item): item is DenialItem => Boolean(item?.tool))
    .map((item, index) => ({
      id: item.id ?? `${d.subtaskId}-d${index + 1}`,
      tool: item.tool,
      command: item.command,
      reason: item.reason ?? "",
      attempts: typeof item.attempts === "number" ? item.attempts : 1,
      rule: item.rule,
      granted: item.granted === true,
    }));
  if (items.length === 0) return undefined;

  return {
    stageId: d.stageId,
    stageName: d.stageName ?? d.stageId,
    subtaskId: d.subtaskId,
    refusedAt: d.refusedAt ?? "",
    items,
  };
}

/**
 * Keeps a stored question only if it is complete enough to act on. A half-written
 * record would render an "answer this" prompt with nothing to answer.
 */
function normalizeQuestion(stored: unknown): PendingQuestion | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const q = stored as Partial<PendingQuestion> & { question?: string };
  if (!q.stageId || !q.subtaskId) return undefined;

  // Records written before questions were itemised held a single string.
  const items: QuestionItem[] = Array.isArray(q.items)
    ? q.items
        .filter((item): item is QuestionItem => Boolean(item?.text?.trim()))
        .map((item, index) => ({
          id: item.id ?? `${q.subtaskId}-q${index + 1}`,
          text: item.text,
          answer: item.answer,
        }))
    : q.question?.trim()
      ? [{ id: `${q.subtaskId}-q1`, text: q.question }]
      : [];
  if (items.length === 0) return undefined;

  return {
    stageId: q.stageId,
    stageName: q.stageName ?? q.stageId,
    subtaskId: q.subtaskId,
    askedAt: q.askedAt ?? "",
    items,
    context: typeof q.context === "string" && q.context.trim() ? q.context.trim() : undefined,
    liveCallId: typeof q.liveCallId === "string" ? q.liveCallId : undefined,
  };
}
