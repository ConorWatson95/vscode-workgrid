import { TaskWorkspace } from "../domain/taskWorkspace";
import { AgentSession, AgentSessionStatus } from "../domain/agentSession";

export interface StartAgentRequest {
  /** Optional initial prompt to send to the agent. */
  initialPrompt?: string;
  /** Optional workflow/slash-command to invoke (e.g. "/plan"). */
  workflow?: string;
}

export interface AgentLogEntry {
  timestamp: string;
  message: string;
}

/**
 * Provider-neutral coding-agent abstraction. Claude Code is the first
 * implementation; the interface intentionally avoids Claude-specific concepts so
 * Codex, Gemini CLI or SDK-backed providers can be added later.
 */
export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;

  isAvailable(): Promise<boolean>;

  startSession(
    workspace: TaskWorkspace,
    request: StartAgentRequest,
  ): Promise<AgentSession>;

  stopSession(session: AgentSession): Promise<void>;

  getStatus(session: AgentSession): Promise<AgentSessionStatus>;

  getLogs(session: AgentSession): Promise<AgentLogEntry[]>;
}
