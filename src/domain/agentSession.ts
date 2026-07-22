export type AgentSessionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "stopped"
  | "completed"
  | "failed";

/**
 * A coding-agent session associated with a task. In the MVP this is backed by a
 * VS Code integrated terminal, so detailed progress is not available — status is
 * driven by terminal open/close events, not output parsing.
 */
export interface AgentSession {
  provider: string;
  processId?: number;
  sessionId?: string;
  status: AgentSessionStatus;
  startedAt?: string;
  stoppedAt?: string;
  logPath?: string;
  lastActivityAt?: string;
}
