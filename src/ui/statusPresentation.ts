import { TaskWorkspaceStatus } from "../domain/taskWorkspace";
import { AgentSessionStatus } from "../domain/agentSession";

/** Maps a task status to a VS Code theme-icon id and a human label. Pure. */
export function taskStatusPresentation(status: TaskWorkspaceStatus): {
  iconId: string;
  label: string;
} {
  switch (status) {
    case "creating":
      return { iconId: "loading~spin", label: "Creating" };
    case "ready":
      return { iconId: "circle-outline", label: "Ready" };
    case "planning":
      return { iconId: "notebook", label: "Planning" };
    case "implementing":
      return { iconId: "play-circle", label: "Implementing" };
    case "awaiting-approval":
      return { iconId: "clock", label: "Awaiting approval" };
    case "reviewing":
      return { iconId: "search", label: "Reviewing" };
    case "testing":
      return { iconId: "beaker", label: "Testing" };
    case "completed":
      return { iconId: "check", label: "Completed" };
    case "failed":
      return { iconId: "error", label: "Failed" };
    case "archived":
      return { iconId: "archive", label: "Archived" };
    default:
      return { iconId: "circle-outline", label: status };
  }
}

/**
 * Coarse, user-facing activity of a live agent session, derived from the
 * stream session's status. Only sessions we actually drive (built-in chat mode)
 * produce this; native/terminal agents are opaque to us.
 */
export type AgentActivity =
  | "starting"
  | "working"
  | "input-required"
  | "finished"
  | "failed";

/** Maps a live session status to a coarse activity, or undefined if untracked. */
export function deriveAgentActivity(
  status: AgentSessionStatus | undefined,
  busy: boolean,
): AgentActivity | undefined {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "working";
    case "waiting":
      // Turn complete: Claude is idle and waiting for the next user message.
      return busy ? "working" : "input-required";
    case "completed":
    case "stopped":
      return "finished";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Icon + theme colour + label for a live agent activity. Colour ids are
 * built-in VS Code chart colours so they adapt to light/dark themes.
 */
export function agentActivityPresentation(activity: AgentActivity): {
  iconId: string;
  colorId?: string;
  label: string;
} {
  switch (activity) {
    case "starting":
      return { iconId: "loading~spin", colorId: "charts.blue", label: "Starting" };
    case "working":
      return { iconId: "loading~spin", colorId: "charts.blue", label: "Working" };
    case "input-required":
      return { iconId: "comment-unresolved", colorId: "charts.yellow", label: "Awaiting input" };
    case "finished":
      return { iconId: "pass-filled", colorId: "charts.green", label: "Finished" };
    case "failed":
      return { iconId: "error", colorId: "charts.red", label: "Failed" };
  }
}

/** Whether an agent can currently be started/stopped for a session state. */
export function agentControls(agentStatus: AgentSessionStatus | undefined): {
  startable: boolean;
  stoppable: boolean;
} {
  const running = agentStatus === "starting" || agentStatus === "running" || agentStatus === "waiting";
  return { startable: !running, stoppable: running };
}

/**
 * Builds the tree item contextValue used by menu `when` clauses. Space-joined
 * tokens are matched with `viewItem =~ /token/` in package.json.
 */
export function buildContextValue(
  status: TaskWorkspaceStatus,
  agentStatus: AgentSessionStatus | undefined,
  harnessed = false,
  hasQuestions = false,
  hasDenials = false,
): string {
  const tokens = ["task"];
  const { startable, stoppable } = agentControls(agentStatus);
  if (startable && status !== "archived") tokens.push("agentStartable");
  if (stoppable) tokens.push("agentStoppable");
  // Distinguish archived (can be restored) from active (can be archived).
  tokens.push(status === "archived" ? "archived" : "archivable");
  // A harnessed task is driven by its route, so the row offers one action —
  // advance — rather than three ways to start an ad-hoc chat. The chat modes stay
  // available in the context menu; they are just no longer the obvious thing.
  //
  // "adhoc" rather than "unharnessed" deliberately: menu `when` clauses match
  // contextValue by substring, and /harnessed/ would match "unharnessed" too.
  tokens.push(harnessed ? "harnessed" : "adhoc");
  // An outstanding question is the one thing a route cannot recover on its own,
  // so the row has to offer a way back to it however the panel was closed.
  if (hasQuestions) tokens.push("hasQuestions");
  // A refused tool call blocks the route just as an unanswered question does.
  if (hasDenials) tokens.push("hasDenials");
  return tokens.join(" ");
}
