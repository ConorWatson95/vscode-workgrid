/**
 * Routes are the *declared* half of the harness: a named, ordered skeleton of
 * stages that a kind of task is expected to travel through. They are static
 * config, not agent output, so a task's shape is predictable before any agent
 * runs and testable without one.
 *
 * The agent's job is only to fill a splittable stage with concrete subtasks
 * (see `planStage` in ./pipelineEngine). Route in, subtasks out.
 */

/**
 * What kind of verification a stage performs. This is what lets the harness
 * distinguish review types — the point being that "review" is not one thing:
 * code review reads the diff, domain review needs subject knowledge, and
 * behaviour review asks what a human must exercise at runtime because
 * correctness depends on business behaviour rather than static analysis.
 */
export type StageKind =
  /**
   * Decides what should be done, and changes nothing.
   *
   * Separate from `implementation` for the same reason `deployment` is: only one
   * of them authored the work a review has findings about. Sending findings to
   * planning is a real and sometimes necessary move — a review that says an object
   * is in the wrong layer has found a *planning* error, and re-implementing
   * against the same wrong plan reproduces it — but it re-opens everything after
   * planning, so it must be asked for by name rather than picked up by a review
   * that only meant "back to whoever wrote this".
   */
  | "planning"
  /** Produces or changes code. */
  | "implementation"
  /**
   * Ships work that already exists to an environment — deploy, promote, publish.
   *
   * Distinct from `implementation` because otherwise the two are indistinguishable
   * to anything reasoning about which stage *authored* the work. That is not
   * academic: `sendBackTo: ["kind:implementation"]` on a review resolved to the
   * nearest earlier implementation stage, which in a route that deploys before it
   * reviews is the deployment — so the obvious way back from a failed review was
   * to run the deployment again rather than fix what failed.
   */
  | "deployment"
  /** Writes or runs automated tests. */
  | "test"
  /** Reads the diff for correctness and scope. */
  | "codeReview"
  /** Subject-specific review, e.g. SQL, reporting, API compatibility. */
  | "domainReview"
  /**
   * Identifies what cannot be settled statically and must be exercised at
   * runtime. Its output is a checklist for a human, not a verdict.
   */
  | "behaviourReview"
  /** A human works through the accumulated checklist before merge. */
  | "humanVerification";

/** Every stage kind, for validating config that names one. */
export const ALL_STAGE_KINDS: readonly StageKind[] = [
  "planning",
  "implementation",
  "deployment",
  "test",
  "codeReview",
  "domainReview",
  "behaviourReview",
  "humanVerification",
];

/** Marks a `sendBackTo` entry as naming a stage kind rather than a stage id. */
export const SEND_BACK_KIND_PREFIX = "kind:";

/**
 * The kind a `sendBackTo` entry names, or undefined when it names an id.
 *
 * Returns undefined for a misspelled kind as well as for an id, so a caller that
 * resolves targets treats `kind:implementaton` as matching nothing rather than as
 * an id that happens to start with "kind:". The config loaders report the typo;
 * resolution stays quiet and safe.
 */
export function sendBackEntryKind(entry: string): StageKind | undefined {
  if (!entry.startsWith(SEND_BACK_KIND_PREFIX)) return undefined;
  const kind = entry.slice(SEND_BACK_KIND_PREFIX.length).trim();
  return ALL_STAGE_KINDS.find((candidate) => candidate === kind);
}

/** Whether an entry is meant as a kind, however badly spelled. */
export function looksLikeKindEntry(entry: string): boolean {
  return entry.startsWith(SEND_BACK_KIND_PREFIX);
}

/** Stage kinds whose output is a checklist rather than a pass/fail judgement. */
export function producesChecklist(kind: StageKind): boolean {
  return kind === "behaviourReview" || kind === "humanVerification";
}

/** Gate applied once every subtask in a stage has resolved. */
export type StageGate =
  /** Advance to the next stage immediately. */
  | "auto"
  /** Hold at the stage until a human approves it. */
  | "approval";

export interface RouteStageDefinition {
  /** Stable within a route; persisted, so never renumber existing values. */
  id: string;
  label: string;
  kind: StageKind;
  /**
   * What the agent is being asked to achieve at this stage, in prose. Used as
   * the prompt for non-splittable stages and as the brief for splitting.
   */
  intent: string;
  /** Optional slash-command to invoke instead of a plain prompt, e.g. "/review". */
  workflow?: string;
  /**
   * Model for this stage's sessions, overriding the extension-wide setting.
   *
   * Stages differ enormously in what they need. Deciding which of three
   * directories a script belongs in is mostly reading and comparing; writing the
   * migration that will run against a live database is not. On a measured route
   * roughly 80% of a planning stage's wall clock was model time, so this is the
   * one dial that moves it — while leaving the stages that actually change
   * things on the stronger model.
   */
  model?: string;
  /**
   * When true the stage is expected to be broken into subtasks by a planning
   * agent before it can run. When false it runs as a single unit of work.
   */
  splittable: boolean;
  gate: StageGate;
  /**
   * Stages this one's findings may be sent back to.
   *
   * Each entry is either a stage id, or `kind:<StageKind>` for "the nearest
   * earlier stage of that kind". The second form exists because **a rule's stage
   * cannot name route stage ids**: one rule applies to every route whose diff
   * matches it, and it has no idea what those routes call their stages. A SQL
   * review spliced in by a rule says `kind:implementation` and lands correctly
   * wherever it is spliced.
   *
   * Opt-in per stage, and empty by default, because the capability is only safe
   * where the route says it is: a planning stage able to send work back to
   * planning plans forever. Naming a kind rather than an id does not weaken that —
   * resolution only ever looks at *earlier* stages, so no entry of either form can
   * target the stage itself or anything after it.
   */
  sendBackTo?: readonly string[];
  /**
   * Carry this stage's conclusion forward to the stages after it.
   *
   * Off by default. A fresh session per subtask is what makes a review independent
   * and a stage cheap to reason about, and carrying every stage's reply forward
   * would rebuild the long conversation the design avoids. Set it on the stages
   * whose *conclusions* later stages need — a planning stage, a stage that
   * established where something lives — not on ones whose output is the code
   * itself, which the next stage can simply read.
   */
  handoff?: boolean;
  /**
   * Whether this stage may change which branch the worktree has checked out.
   *
   * Off by default, and the default is the safety property: a stage that switched
   * branches to go and look for something redefined the task, because git is the
   * source of truth for a worktree's branch and reconciliation adopts what it finds.
   * A migration review did exactly that, found no migration scripts on the branch it
   * had moved to, and reported the absence truthfully about the wrong tree.
   *
   * On for the stages where moving is the work: a UAT promotion goes through a PR,
   * and a live publish runs out of the standing publish worktrees. Such a stage is
   * asked to return the worktree to the task's branch when it is done, and any later
   * stage without this flag refuses to run until it is.
   */
  mayChangeBranch?: boolean;
}

export interface RouteDefinition {
  id: string;
  label: string;
  description: string;
  stages: readonly RouteStageDefinition[];
}

/**
 * The terminal human-verification stage every route ends with. It is also the
 * anchor the rules engine inserts before: conditional reviews derived from the
 * diff always land after code review and before a human signs off.
 */
const HUMAN_VERIFICATION: RouteStageDefinition = {
  id: "human-verification",
  label: "Human verification",
  kind: "humanVerification",
  intent:
    "Work through the accumulated verification checklist in a running build. " +
    "Nothing here can be settled by reading code.",
  splittable: false,
  gate: "approval",
};

/** Code review applies to every route, so it is declared once. */
const CODE_REVIEW: RouteStageDefinition = {
  id: "code-review",
  label: "Code review",
  kind: "codeReview",
  intent: "Review the complete diff for correctness and scope creep.",
  workflow: "/review",
  splittable: false,
  gate: "auto",
};

/**
 * Built-in routes. Deliberately thin — a route describes only the work that is
 * unconditionally required for that *kind of task*. Reviews that depend on what
 * the change actually touched are not listed here; they are appended by
 * `applyRules` once a diff exists, because at creation time nobody knows
 * whether a bug fix will end up touching SQL or a mapping profile.
 *
 * Every route ends at a human gate, so no route can mark itself finished.
 */
export const BUILT_IN_ROUTES: readonly RouteDefinition[] = [
  {
    id: "bug-fix",
    label: "Bug fix",
    description: "Reproduce first, then fix, then prove it stays fixed.",
    stages: [
      {
        id: "reproduce",
        label: "Reproduce",
        kind: "implementation",
        intent:
          "Reproduce the reported problem and state the smallest failing case. Do not fix anything yet.",
        splittable: false,
        gate: "auto",
      },
      {
        id: "fix",
        label: "Fix",
        kind: "implementation",
        intent: "Correct the root cause identified during reproduction.",
        splittable: true,
        gate: "auto",
      },
      {
        id: "regression-test",
        label: "Regression test",
        kind: "test",
        intent:
          "Add a regression test that fails without the fix, and run the suite.",
        splittable: false,
        gate: "auto",
      },
      CODE_REVIEW,
      HUMAN_VERIFICATION,
    ],
  },
  {
    id: "feature",
    label: "Feature",
    description: "Explore, plan, build in slices, then verify.",
    stages: [
      {
        id: "explore",
        label: "Explore",
        kind: "implementation",
        intent:
          "Map the code this feature touches and report the integration points. Change nothing.",
        splittable: false,
        gate: "auto",
      },
      {
        id: "plan",
        label: "Plan",
        kind: "implementation",
        intent: "Decide the implementation approach and the order of work.",
        splittable: false,
        gate: "approval",
      },
      {
        id: "build",
        label: "Build",
        kind: "implementation",
        intent: "Implement the planned approach one slice at a time.",
        splittable: true,
        gate: "auto",
      },
      {
        id: "tests",
        label: "Tests",
        kind: "test",
        intent: "Cover the new behaviour with tests and run the suite.",
        splittable: true,
        gate: "auto",
      },
      CODE_REVIEW,
      HUMAN_VERIFICATION,
    ],
  },
  {
    id: "refactor",
    label: "Refactor",
    description: "Pin behaviour with tests, restructure, then verify parity.",
    stages: [
      {
        id: "baseline",
        label: "Baseline",
        kind: "test",
        intent:
          "Establish the current behaviour and confirm the suite passes before touching anything.",
        splittable: false,
        gate: "auto",
      },
      {
        id: "restructure",
        label: "Restructure",
        kind: "implementation",
        intent: "Restructure the code without changing observable behaviour.",
        splittable: true,
        gate: "auto",
      },
      {
        id: "parity",
        label: "Verify parity",
        kind: "test",
        intent:
          "Re-run the suite and justify every behavioural difference from the baseline.",
        splittable: false,
        gate: "auto",
      },
      CODE_REVIEW,
      HUMAN_VERIFICATION,
    ],
  },
];

export function findRoute(routeId: string): RouteDefinition | undefined {
  return BUILT_IN_ROUTES.find((route) => route.id === routeId);
}
