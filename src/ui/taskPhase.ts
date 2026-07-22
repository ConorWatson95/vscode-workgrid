import { AgentActivity } from "./statusPresentation";

/**
 * A task's position in its development lifecycle, derived from live git state
 * and (when available) agent activity. This is what the sidebar dot reflects —
 * a far more meaningful signal than raw chat activity alone.
 *
 * Flow: ready → planning/implementing (agent working) → changes-uncommitted
 *       → committed. "needs-input" interrupts when the agent is waiting on you.
 */
export type TaskPhase =
  | "planning"
  | "implementing"
  | "needs-input"
  | "changes-uncommitted"
  | "committed"
  | "ready";

export interface PhaseInputs {
  /** Live agent activity, if we can observe it. */
  activity: AgentActivity | undefined;
  /** Uncommitted changes in the working tree. */
  dirty: boolean;
  /** Commits on HEAD not yet on the base branch. */
  commitsAhead: number;
}

/**
 * Pure derivation of the task phase.
 *
 * Priority:
 *  1. Agent actively working → planning (nothing changed yet) or implementing.
 *  2. Agent waiting on you → needs-input.
 *  3. At rest, reflect git: uncommitted changes → changes-uncommitted;
 *     committed work ahead of base → committed; otherwise ready.
 */
export function deriveTaskPhase(inputs: PhaseInputs): TaskPhase {
  const { activity, dirty, commitsAhead } = inputs;

  if (activity === "working") {
    return dirty ? "implementing" : "planning";
  }
  if (activity === "input-required") {
    return "needs-input";
  }
  if (dirty) return "changes-uncommitted";
  if (commitsAhead > 0) return "committed";
  return "ready";
}

/** Icon + theme colour + label for a phase. Colours adapt to light/dark. */
export function taskPhasePresentation(phase: TaskPhase): {
  iconId: string;
  colorId?: string;
  label: string;
  spin?: boolean;
} {
  switch (phase) {
    case "planning":
      return { iconId: "loading~spin", colorId: "charts.purple", label: "Planning", spin: true };
    case "implementing":
      return { iconId: "loading~spin", colorId: "charts.blue", label: "Implementing", spin: true };
    case "needs-input":
      return { iconId: "comment-unresolved", colorId: "charts.yellow", label: "Needs input" };
    case "changes-uncommitted":
      return { iconId: "request-changes", colorId: "charts.orange", label: "Uncommitted changes" };
    case "committed":
      return { iconId: "check-all", colorId: "charts.green", label: "Committed" };
    case "ready":
      return { iconId: "circle-outline", label: "Ready" };
  }
}
