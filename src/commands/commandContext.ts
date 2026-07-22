import * as vscode from "vscode";
import { TaskWorkspaceService } from "../services/taskWorkspaceService";
import { GitWorktreeService } from "../git/gitWorktreeService";
import { GitStatusService } from "../git/gitStatusService";
import { TaskRepository } from "../persistence/taskRepository";
import { ExtensionConfiguration } from "../configuration/extensionConfiguration";
import { TerminalManager } from "../processes/terminalManager";
import { AgentProviderRegistry } from "../agents/agentProviderRegistry";
import { AgentSessionManager } from "../agents/agentSessionManager";
import { SessionArchive } from "../agents/sessionArchive";
import { ArchivedHistoryRepository } from "../persistence/archivedHistoryRepository";
import { TaskWorkspaceTreeProvider } from "../ui/taskWorkspaceTreeProvider";
import { TaskDetailViewProvider } from "../ui/taskDetailViewProvider";
import { DiffContentProvider } from "../ui/diffContentProvider";
import { Logger } from "../logging/logger";

/** Shared dependencies handed to every command handler. */
export interface CommandContext {
  service: TaskWorkspaceService;
  worktrees: GitWorktreeService;
  status: GitStatusService;
  repository: TaskRepository;
  configuration: ExtensionConfiguration;
  terminals: TerminalManager;
  agents: AgentProviderRegistry;
  sessions: AgentSessionManager;
  archive: SessionArchive;
  archivedHistory: ArchivedHistoryRepository;
  diffProvider: DiffContentProvider;
  detailView: TaskDetailViewProvider;
  tree: TaskWorkspaceTreeProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
  globalState: vscode.Memento;
  resolveRepositoryRoot: () => string | undefined;
  repositoryUri: () => vscode.Uri | undefined;
}

/** Key under which a pending "launch native Claude chat" request is stored. */
export const PENDING_NATIVE_CHAT_KEY = "taskWorkspaces.pendingNativeChat";

/** The official Claude Code extension id and the command that opens its chat. */
export const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
export const CLAUDE_OPEN_CHAT_COMMAND = "claude-vscode.editor.open";
