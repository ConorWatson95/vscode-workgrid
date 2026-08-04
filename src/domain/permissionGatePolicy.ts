import { GateDecision } from "../agents/permissionGateProtocol";

/**
 * Decides whether a gated tool call should be held for a human, answered from a
 * standing approval, or waved through.
 *
 * This is where the cost of `PreToolUse` firing on **every** call is paid down.
 * Holding everything would stop the agent constantly and make the harness
 * unusable; holding nothing would be today's behaviour, where a refusal costs
 * several turns of rewording and then a stage re-run.
 *
 * The compromise rests on one observation: the extension already learns about a
 * refusal the moment it happens, from the stream. So a capability is waved
 * through the first time, refused by the CLI as it would be anyway, and *then*
 * gated — because by the retry we know a human is needed. The agent's first
 * attempt is not wasted work we added; it is the attempt it always made.
 *
 * The alternative — replicating the CLI's own "is this command safe" classifier
 * so we could hold only calls it would refuse — was rejected deliberately. It
 * would mean maintaining a list of safe commands in this extension, guessing at
 * another tool's policy, and being wrong in the direction of blocking a stage on
 * `git status`.
 *
 * Pure and vscode-free.
 */

/** How long an approval lasts. */
export type ApprovalScope =
  /** This one call. The next one asks again. */
  | "once"
  /** Every matching call until the extension restarts. */
  | "session"
  /** Session, plus a rule written to the project's settings. */
  | "always";

/**
 * A decision that outlives the call it was made for.
 *
 * Only `session` and `always` are ever stored: an "approve once" is satisfied by
 * answering the waiting call itself, so remembering it would mean approving the
 * *next* call too, which is the opposite of what the user asked for.
 */
export interface StandingApproval {
  scope: Exclude<ApprovalScope, "once">;
  /** Deny rather than allow, so a refusal is not re-asked in a loop. */
  deny?: boolean;
}

export interface GatePolicyState {
  /** Call keys the CLI has already refused in this task. */
  refused: ReadonlySet<string>;
  /** Standing decisions the user has made, by call key. */
  approvals: ReadonlyMap<string, StandingApproval>;
  /** Whether the user wants everything held, rather than only known refusals. */
  holdEverything?: boolean;
}

export type GateVerdict =
  /** Answer the hook straight away. */
  | { kind: "answer"; decision: Exclude<GateDecision, "pass">; reason: string }
  /** Let the CLI decide, as if the gate were not installed. */
  | { kind: "pass" }
  /** Hold the call open and put it in front of the user. */
  | { kind: "hold" };

/**
 * The verdict for one call.
 *
 * Order matters. A standing decision wins over everything, so approving a
 * capability never asks twice and denying it never loops. Only then does the
 * "have we seen this refused" question apply.
 */
export function gateVerdict(
  state: GatePolicyState,
  callKey: string,
): GateVerdict {
  const standing = state.approvals.get(callKey);
  if (standing) {
    return {
      kind: "answer",
      decision: standing.deny ? "deny" : "allow",
      reason: standing.deny
        ? "Denied in Task Workspaces."
        : approvalReason(standing.scope),
    };
  }

  if (state.holdEverything) return { kind: "hold" };

  // Known to need a human: the CLI refused this capability earlier in the task.
  if (state.refused.has(callKey)) return { kind: "hold" };

  // Unknown, so let the CLI's classifier rule. Safe reads stay fast, and a
  // refusal here is what teaches us to hold the retry.
  return { kind: "pass" };
}

function approvalReason(scope: StandingApproval["scope"]): string {
  switch (scope) {
    case "session":
      return "Approved for this session in Task Workspaces.";
    case "always":
      return "Approved in Task Workspaces; a rule was added.";
  }
}
