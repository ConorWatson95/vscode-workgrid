import * as vscode from "vscode";
import { TaskWorkspaceService } from "../services/taskWorkspaceService";
import { GitWorktreeService } from "../git/gitWorktreeService";
import { GitStatusService } from "../git/gitStatusService";
import { GitMergeService } from "../git/gitMergeService";
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
import { ReportContentProvider } from "../ui/reportContentProvider";
import { GitBlobContentProvider } from "../ui/gitBlobContentProvider";
import { Logger } from "../logging/logger";
import { VisualStudioService } from "../projects/visualStudioService";
import { ReviewPlanService } from "../services/reviewPlanService";
import { PipelineRunner } from "../services/pipelineRunner";
import { WorktreeProvisioner } from "../services/worktreeProvisioner";
import { PermissionRulesService } from "../services/permissionRulesService";
import { PermissionGateService } from "../services/permissionGateService";
import { AskUserService } from "../services/askUserService";
import { WorktreeClaimService } from "../services/worktreeClaimService";
import { StageDefinitionSource } from "../domain/stageRefresh";

/** Shared dependencies handed to every command handler. */
export interface CommandContext {
  service: TaskWorkspaceService;
  worktrees: GitWorktreeService;
  status: GitStatusService;
  /** Brings a branch into a task's worktree; see `mergeIntoTaskCommand`. */
  merges: GitMergeService;
  repository: TaskRepository;
  configuration: ExtensionConfiguration;
  terminals: TerminalManager;
  agents: AgentProviderRegistry;
  sessions: AgentSessionManager;
  archive: SessionArchive;
  archivedHistory: ArchivedHistoryRepository;
  diffProvider: DiffContentProvider;
  /** Serves stage/task reports as read-only documents that re-render as a stage runs. */
  reportProvider: ReportContentProvider;
  /** Serves the "before" side of each changed file, for the file-by-file view. */
  blobProvider: GitBlobContentProvider;
  detailView: TaskDetailViewProvider;
  visualStudio: VisualStudioService;
  reviewPlans: ReviewPlanService;
  runner: PipelineRunner;
  /**
   * Who holds which worktree, and which of a finished task's may be tidied away.
   * Optional so the harness commands work without it, as they did before.
   */
  worktreeClaims?: WorktreeClaimService;
  provisioner: WorktreeProvisioner;
  tree: TaskWorkspaceTreeProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
  globalState: vscode.Memento;
  /** Adds allow rules to the project's local Claude settings. */
  permissionRules: PermissionRulesService;
  /**
   * Holds refused tool calls open for approval. Optional so the commands degrade
   * to the after-the-fact denial flow when the gate could not be installed.
   */
  permissionGate?: PermissionGateService;
  /**
   * Lets a blocked stage be answered in place. Optional so the question flow
   * degrades to enriching the brief and re-running when it is not installed.
   */
  askUser?: AskUserService;
  /**
   * Current project config, for reloading a re-opened stage's instructions.
   * Optional so the command degrades to reverting without a reload.
   */
  stageDefinitions?: () => StageDefinitionSource;
  /**
   * The MCP config a session should load: the project's, reduced to the servers
   * `stageMcpServers` names. Supplied rather than computed here because the
   * reduced copy is written to extension storage, which only `activate` knows.
   */
  reducedMcpConfigPath: (taskRepositoryRoot: string) => string | undefined;
  /**
   * Whether that reduction is in force. Sessions must pass `--strict-mcp-config`
   * when it is, or the worktree's own approved config reinstates everything.
   */
  mcpNarrowed: () => boolean;
  resolveRepositoryRoot: () => string | undefined;
  repositoryUri: () => vscode.Uri | undefined;
}

/** Key under which a pending "launch native Claude chat" request is stored. */
export const PENDING_NATIVE_CHAT_KEY = "taskWorkspaces.pendingNativeChat";

/** The official Claude Code extension id and the command that opens its chat. */
export const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
export const CLAUDE_OPEN_CHAT_COMMAND = "claude-vscode.editor.open";
