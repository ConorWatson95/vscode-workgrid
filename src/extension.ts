import * as vscode from "vscode";
import { OutputChannelLogger } from "./logging/outputChannelLogger";
import { GitClient } from "./git/gitClient";
import { GitStatusService } from "./git/gitStatusService";
import { GitWorktreeService } from "./git/gitWorktreeService";
import { ExtensionStateTaskRepository } from "./persistence/extensionStateTaskRepository";
import { NodeStateFileIo } from "./persistence/nodeStateFileIo";
import { RoutedTaskRepository, TaskStateStore } from "./persistence/taskStateStore";
import { TaskWorkspaceService } from "./services/taskWorkspaceService";
import { ExtensionConfiguration } from "./configuration/extensionConfiguration";
import { TerminalManager } from "./processes/terminalManager";
import { AgentProviderRegistry } from "./agents/agentProviderRegistry";
import { AgentSessionManager } from "./agents/agentSessionManager";
import { SessionArchive } from "./agents/sessionArchive";
import { ArchivedHistoryRepository } from "./persistence/archivedHistoryRepository";
import { NativeSessionWatcher } from "./agents/nativeSessionWatcher";
import { ClaudeCodeProvider } from "./agents/claudeCodeProvider";
import * as os from "node:os";
import { TaskWorkspaceTreeProvider } from "./ui/taskWorkspaceTreeProvider";
import { TaskWorkspaceTreeItem } from "./ui/taskWorkspaceTreeItem";
import { TaskDetailViewProvider } from "./ui/taskDetailViewProvider";
import { PlanUsageViewProvider } from "./ui/planUsageViewProvider";
import { VisualStudioService } from "./projects/visualStudioService";
import { PlanUsageService } from "./agents/planUsageService";
import { DiffContentProvider, DIFF_SCHEME } from "./ui/diffContentProvider";
import { deriveAgentActivity } from "./ui/statusPresentation";
import { registerCommands } from "./commands/registerCommands";
import { ReviewPlanService } from "./services/reviewPlanService";
import { loadHarness, loadReviewRules } from "./services/reviewRulesService";
import { PipelineRunner } from "./services/pipelineRunner";
import { ClaudeStageSessionRunner } from "./agents/stageSessionRunner";
import { resolveMcpConfigPath } from "./agents/claudeCliArgs";
import { filterMcpConfig } from "./agents/mcpConfigFilter";
import * as fs from "node:fs";
import { WorktreeProvisioner } from "./services/worktreeProvisioner";
import { PermissionRulesService } from "./services/permissionRulesService";
import { suggestAllowRule, suggestAllowRules } from "./agents/permissionDenials";
import { PendingGate, PermissionGateService } from "./services/permissionGateService";
import { nextAnnouncements } from "./domain/permissionGatePolicy";
import { nodeGateFileSystem } from "./services/gateFileSystem";
import {
  CommandContext,
  PENDING_NATIVE_CHAT_KEY,
  CLAUDE_EXTENSION_ID,
  CLAUDE_OPEN_CHAT_COMMAND,
} from "./commands/commandContext";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("Task Workspaces", { log: true });
  const logger = new OutputChannelLogger(channel);
  context.subscriptions.push(channel);
  logger.info("Task Workspaces activating.");

  const configuration = new ExtensionConfiguration();
  const gitClient = new GitClient(logger);
  const statusService = new GitStatusService(gitClient);
  const worktreeService = new GitWorktreeService(gitClient, statusService);
  // Resolved below, but declared here because the task store reads it on every
  // call: the active repository decides which state file is in play.
  let repositoryRoot: string | undefined;
  let repositoryUri: vscode.Uri | undefined;

  // --- Task state -------------------------------------------------------
  // The source of truth is a file under the repository's own git directory, not
  // extension state, so a headless run of the harness and this window act on
  // the same tasks. The Memento is kept as the adoption source for repositories
  // last written by an older version, and as the store of last resort when no
  // git repository is active.
  const legacyRepository = new ExtensionStateTaskRepository(
    context.globalState,
    logger,
  );
  const stateStore = new TaskStateStore({
    io: new NodeStateFileIo(),
    git: worktreeService,
    legacy: legacyRepository,
    logger,
  });
  // Declared before `repositoryRoot` exists, and read on every call, because the
  // active repository is resolved after the service graph is built and can
  // change while the window is open.
  const repository = new RoutedTaskRepository(async () => {
    if (!repositoryRoot) return undefined;
    try {
      return await stateStore.forRepository(repositoryRoot);
    } catch (error) {
      // Falling back keeps the window usable; without this a transient git
      // failure would empty the task list, which reads as data loss.
      logger.error(
        `Falling back to extension state for tasks: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }, legacyRepository);

  const service = new TaskWorkspaceService(
    repository,
    worktreeService,
    statusService,
    logger,
  );

  // --- Active repository resolution -------------------------------------
  const resolveRepository = async (): Promise<void> => {
    repositoryRoot = undefined;
    repositoryUri = undefined;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = await worktreeService.getRepositoryRoot(folder.uri.fsPath);
      if (root.ok) {
        repositoryRoot = root.value;
        repositoryUri = folder.uri;
        break;
      }
    }
    await vscode.commands.executeCommand(
      "setContext",
      "taskWorkspaces.active",
      repositoryRoot !== undefined,
    );
    logger.info(`Active repository: ${repositoryRoot ?? "(none)"}`);
  };

  await resolveRepository();

  // --- Agents -----------------------------------------------------------
  const terminals = new TerminalManager();
  context.subscriptions.push(terminals);
  const agents = new AgentProviderRegistry();
  agents.register(
    new ClaudeCodeProvider(
      terminals,
      logger,
      () => configuration.claudeCommand(repositoryUri),
    ),
  );
  const sessions = new AgentSessionManager(logger, () =>
    configuration.claudeCommand(repositoryUri),
  );
  context.subscriptions.push({ dispose: () => sessions.dispose() });

  // Plan usage is account-wide; probe from the repo root (any directory works).
  const planUsage = new PlanUsageService(
    logger,
    () => configuration.claudeCommand(repositoryUri),
    () => repositoryRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );

  // Detects Visual Studio solutions so the details view can offer to open them.
  // Reuses the git file listing the chat panel already relies on.
  const visualStudio = new VisualStudioService(logger, async (worktreePath) => {
    const result = await worktreeService.listFiles(worktreePath);
    return result.ok ? result.value : [];
  });

  const nativeWatcher = new NativeSessionWatcher(os.homedir(), logger);
  nativeWatcher.start();
  context.subscriptions.push({ dispose: () => nativeWatcher.dispose() });

  const archive = new SessionArchive(
    vscode.Uri.joinPath(context.globalStorageUri, "history").fsPath,
  );
  const archivedHistory = new ArchivedHistoryRepository(context.globalState);

  const diffProvider = new DiffContentProvider();
  context.subscriptions.push(
    diffProvider,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
  );

  // Holds a refused tool call open until the user decides, so the agent carries
  // on mid-turn instead of the stage being re-run once a rule is added. Created
  // before the tree because the tree renders what it is holding.
  const permissionGate = new PermissionGateService(
    vscode.Uri.joinPath(context.globalStorageUri, "permission-gates").fsPath,
    nodeGateFileSystem,
    logger,
    () => configuration.gateInterpreter(repositoryUri),
    () => configuration.gatedTools(repositoryUri),
    () => Math.round(configuration.permissionWaitMinutes(repositoryUri) * 60),
    () => configuration.holdEveryToolCall(repositoryUri),
  );
  context.subscriptions.push({ dispose: () => permissionGate.dispose() });

  // --- Tree view --------------------------------------------------------
  const tree = new TaskWorkspaceTreeProvider(
    service,
    () => repositoryRoot,
    logger,
    (task) => {
      // A built-in chat session (which we drive) is authoritative.
      const session = sessions.get(task.id);
      if (session) return deriveAgentActivity(session.status, session.busy);
      // Otherwise, best-effort native activity from transcript freshness.
      if (configuration.trackNativeActivity(repositoryUri)) {
        nativeWatcher.ensure(task.worktreePath);
        return nativeWatcher.activityFor(task.worktreePath);
      }
      return undefined;
    },
    (taskId) => permissionGate.waiting(taskId),
    (held) =>
      // Reuses the denial rule derivation, so "Always allow" produces the same
      // shape of rule as the after-the-fact flow — tool-aware, and generalised
      // past the ticket-specific filename.
      suggestAllowRule({
        tool: held.request.toolName,
        command: held.detail,
        reason: "held for approval",
        attempts: 1,
      }),
  );
  context.subscriptions.push(tree);

  const treeView = vscode.window.createTreeView("taskWorkspaces.tree", {
    treeDataProvider: tree,
  });
  context.subscriptions.push(treeView);

  // --- Docked detail view ----------------------------------------------
  const detailView = new TaskDetailViewProvider(context.extensionUri, {
    getTask: (id) => repository.get(id),
    getLiveState: (task) => service.getLiveState(task),
    getActivity: (taskId) => {
      const session = sessions.get(taskId);
      return session ? deriveAgentActivity(session.status, session.busy) : undefined;
    },
    detectVisualStudio: (worktreePath) => visualStudio.detect(worktreePath),
    run: (taskId, action) => {
      const map: Record<string, string> = {
        open: "taskWorkspaces.open",
        visualStudio: "taskWorkspaces.openInVisualStudio",
        explorer: "taskWorkspaces.revealInExplorer",
        startNative: "taskWorkspaces.startNative",
        startChat: "taskWorkspaces.startChat",
        startTerminal: "taskWorkspaces.startTerminal",
        diff: "taskWorkspaces.showDiff",
        copy: "taskWorkspaces.copyPath",
        archive: "taskWorkspaces.archive",
        unarchive: "taskWorkspaces.unarchive",
        remove: "taskWorkspaces.remove",
      };
      void vscode.commands.executeCommand(map[action], taskId);
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TaskDetailViewProvider.viewId, detailView),
  );

  // --- Plan usage view --------------------------------------------------
  // Its own view rather than a details section: usage is account-wide, so it
  // shouldn't come and go with the tree selection.
  const usageView = new PlanUsageViewProvider(context.extensionUri, {
    getUsage: () => planUsage.current(),
    isUsageRefreshing: () => planUsage.isRefreshing(),
    refreshUsage: (force) => {
      void (force ? planUsage.refresh() : planUsage.refreshIfStale());
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PlanUsageViewProvider.viewId, usageView),
    { dispose: () => usageView.dispose() }, // stops the refresh ticker
  );

  // Update the detail view as the tree selection changes.
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      const selected = e.selection.find((n): n is TaskWorkspaceTreeItem => n instanceof TaskWorkspaceTreeItem);
      detailView.show(selected?.task.id);
    }),
  );

  // Keep the detail view in sync with every tree refresh (command actions,
  // reconciliation, session/native changes all flow through here).
  context.subscriptions.push(tree.onDidChangeTreeData(() => detailView.refresh()));
  // Re-render once a usage probe lands.
  context.subscriptions.push(planUsage.onDidChange(() => usageView.refresh()));

  // Live-update the tree as sessions or native transcripts change.
  context.subscriptions.push(sessions.onDidChange(() => tree.refresh()));
  context.subscriptions.push(nativeWatcher.onDidChange(() => tree.refresh()));

  // When an agent terminal closes, refresh so its status updates.
  context.subscriptions.push(
    terminals.onDidCloseTaskTerminal(async (taskId) => {
      const task = await repository.get(taskId);
      if (task?.agent) {
        await repository.save({
          ...task,
          agent: { ...task.agent, status: "stopped" },
        });
      }
      tree.refresh();
    }),
  );

  // Recompute the active repo and refresh when folders change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await resolveRepository();
      tree.refresh();
    }),
  );

  // Rules are resolved per repository, and the configured path is
  // resource-scoped, so each project can keep its own rule set.
  const reviewPlans = new ReviewPlanService(
    statusService,
    repository,
    logger,
    (root) =>
      loadReviewRules(root, {
        configuredPath: configuration.harnessConfigPath(repositoryUri),
      }),
  );

  // A held call is live state the tree cannot derive, so it has to be told.
  //
  // It also has to be *said*. A hold is the only moment the agent is genuinely
  // blocked on a person, and it used to produce nothing but a tree row and a log
  // line — so a stage waiting on one click looked hung until the CLI's hook
  // timeout expired, which is minutes of nothing happening. The actions here
  // answer the waiting hook, so the agent continues mid-turn; dismissing the
  // notification changes nothing, because the row offers the same decisions.
  let announcedHolds: ReadonlySet<string> = new Set();

  const announceHeldCall = async (held: PendingGate): Promise<void> => {
    const task = await repository.get(held.taskId);
    const allowOnce = "Allow";
    const allowSession = "Allow for Session";
    const deny = "Deny";
    const choice = await vscode.window.showWarningMessage(
      `"${task?.name ?? held.taskId}": ${held.request.toolName} is waiting for permission — ${held.detail}`,
      allowOnce,
      allowSession,
      deny,
    );
    if (choice === undefined) return;

    const answered = permissionGate.decide(
      held.request.id,
      choice === deny ? "deny" : "allow",
      choice === allowSession ? "session" : "once",
    );
    if (!answered) {
      // The hook gave up waiting, or the stage ended while the notification was
      // on screen. Saying so beats a button that silently did nothing.
      void vscode.window.showWarningMessage(
        "That call is no longer waiting — the stage moved on or timed out.",
      );
    }
    tree.refresh();
  };

  context.subscriptions.push({
    dispose: permissionGate.onChanged(() => {
      tree.refresh();
      const waiting = permissionGate.waiting();
      const { announce, remember } = nextAnnouncements(
        announcedHolds,
        waiting.map((held) => held.request.id),
      );
      announcedHolds = remember;
      for (const id of announce) {
        const held = waiting.find((entry) => entry.request.id === id);
        if (held) void announceHeldCall(held);
      }
    }),
  });

  /**
   * The MCP config a *stage* session should load.
   *
   * Every subtask is a fresh CLI, and the CLI starts every server in the config
   * before emitting its first event — nine servers measured at 182 seconds of
   * connect timeouts, paid per subtask. When `stageMcpServers` names the ones a
   * route needs, a reduced copy is written to extension storage and passed
   * instead.
   *
   * Written outside the repository on purpose: it must not appear in a worktree,
   * where it would land in the changed paths the review rules key off. Filtering
   * only removes servers, so this cannot widen what a branch can reach.
   */
  const stageMcpConfigPath = (taskRepositoryRoot: string): string | undefined => {
    const resolved = resolveMcpConfigPath(
      taskRepositoryRoot,
      configuration.mcpConfigPath(repositoryUri),
      (p) => fs.existsSync(p),
    );
    if (!resolved) return undefined;

    const allow = configuration.stageMcpServers(repositoryUri);
    if (allow.length === 0) return resolved;

    try {
      const filtered = filterMcpConfig(fs.readFileSync(resolved, "utf8"), allow);
      // Undefined means there was nothing sensible to do — a typo in the
      // allow-list, or a config we could not read. Never a reason to strip a
      // stage's tools, so the original is used unchanged.
      if (!filtered) {
        logger.warn(
          `taskWorkspaces.stageMcpServers matched no server in ${resolved}; ` +
            "using the project's config unchanged.",
        );
        return resolved;
      }

      const directory = vscode.Uri.joinPath(context.globalStorageUri, "stage-mcp");
      fs.mkdirSync(directory.fsPath, { recursive: true });
      const target = vscode.Uri.joinPath(directory, "mcp.json").fsPath;
      fs.writeFileSync(target, filtered.json, "utf8");
      logger.info(
        `Stage MCP config: keeping ${filtered.kept.join(", ")}` +
          (filtered.dropped.length > 0
            ? `; skipping ${filtered.dropped.length} (${filtered.dropped.join(", ")})`
            : ""),
      );
      return target;
    } catch (error) {
      logger.error("Could not reduce the MCP config for stage sessions", error);
      return resolved;
    }
  };

  // Each subtask runs in a fresh session, so route stages never share context.
  const stageRunner = new ClaudeStageSessionRunner(
    sessions,
    (task) => ({
      worktreePath: task.worktreePath,
      permissionMode: configuration.permissionMode(repositoryUri),
      addDirs: [task.repositoryRoot],
      // A stage session runs in a worktree the CLI has never seen, so the
      // project's MCP servers are unapproved there and silently absent — which
      // is how a planning stage loses the ability to read its own ticket.
      mcpConfigPath: stageMcpConfigPath(task.repositoryRoot),
      // Enforced, not merely offered: without strict mode the worktree's own
      // approved `.mcp.json` starts every server anyway, and a reduced config
      // achieves nothing. Only when the set was narrowed on purpose, since strict
      // mode also drops the user's own user-scope servers.
      strictMcpConfig: configuration.stageMcpServers(repositoryUri).length > 0,
      autoCompactThreshold: configuration.autoCompactThreshold(repositoryUri),
      contextStrategy: configuration.contextStrategy(repositoryUri),
      model: configuration.model(repositoryUri),
      taskName: task.name,
    }),
    logger,
    configuration.stageTimeoutMinutes(repositoryUri) * 60 * 1000,
    {
      prepare: (taskId) =>
        configuration.interactivePermissions(repositoryUri)
          ? permissionGate.prepare(taskId)
          : undefined,
      release: (taskId) => permissionGate.release(taskId),
    },
  );
  const permissionRules = new PermissionRulesService(logger);
  // Shared: also used when granting a rule, to refresh an existing worktree's copy.
  const provisioner = new WorktreeProvisioner(logger);

  const runner = new PipelineRunner(
    stageRunner,
    repository,
    reviewPlans,
    logger,
    () => configuration.projectDocsPath(repositoryUri),
    // Announced the instant it happens, so the user is not left waiting out a
    // stage that has already lost the tool it wanted.
    (task, denial) => {
      // The refusal that teaches the gate. From here on this capability is held
      // for the user rather than refused again, so the agent's retry — which it
      // was going to make anyway — becomes the interactive prompt.
      permissionGate.noteDenial(task.id, denial.tool, denial.command);

      // With the gate armed, this refusal is the expected first attempt: the
      // retry is held and the user asked properly, with actions that release the
      // agent where it stands. Interrupting here as well was actively harmful —
      // it offered "Add Rule", which cannot free a call the hook is already
      // holding, and it arrived *before* the prompt that could. The useful
      // notification went unseen behind the useless one, and the stage looked
      // hung. The refusal is still logged, and still listed on the stage's rows
      // if the agent never retries the capability.
      // Suppressed only when the retry will genuinely be held. Three conditions,
      // and every one of them has to hold or this notification is the sole report:
      // the feature is on, the hook is actually installed (`prepare` fails soft),
      // and the gate covers this tool at all — `gatedTools` is a list, so a
      // refusal of anything outside it will never raise a prompt. A denial
      // attributed to the wrong tool used to fall straight through that gap and
      // be reported nowhere.
      const gateWillHoldRetry =
        configuration.interactivePermissions(repositoryUri) &&
        permissionGate.isArmed(task.id) &&
        configuration
          .gatedTools(repositoryUri)
          .some((tool) => tool.toLowerCase() === denial.tool.toLowerCase());
      if (gateWillHoldRetry) return;

      const rules = suggestAllowRules([denial], {
        worktreePath: task.worktreePath,
        repositoryRoot: task.repositoryRoot,
      });
      const rule = rules[0];
      void vscode.window
        .showWarningMessage(
          `"${task.name}": ${denial.tool} was denied — ${denial.command ?? denial.reason}`,
          ...(rule ? ["Add Rule"] : []),
          "Show Log",
        )
        .then(async (choice) => {
          if (choice === "Show Log") {
            logger.show?.();
            return;
          }
          if (choice !== "Add Rule" || !rule) return;
          // Every suggested form, not just the first: the absolute rule matches now and
          // the relative one survives the worktree.
          const written = permissionRules.addAllowRules(task.repositoryRoot, rules);
          if (written.problem) {
            void vscode.window.showErrorMessage(written.problem);
            return;
          }
          // Bring the settings across so the retry, which runs in the worktree,
          // sees the new rule.
          provisioner.provision(
            configuration.copyIntoWorktree(repositoryUri),
            task.repositoryRoot,
            task.worktreePath,
          );
          void vscode.window.showInformationMessage(
            written.added.length > 0
              ? `Rule added. The route will retry this step.`
              : `That rule was already present.`,
          );
        });
    },
    () => configuration.pauseOnPermissionDenial(repositoryUri),
    // Read per advance rather than cached: editing a stage's model in
    // harness.json should take effect on the next stage, not the next task.
    () => {
      const repositoryRoot = repositoryUri?.fsPath;
      if (!repositoryRoot) return undefined;
      return loadHarness(repositoryRoot, {
        configuredPath: configuration.harnessConfigPath(repositoryUri),
      });
    },
  );

  // --- Commands ---------------------------------------------------------
  const commandContext: CommandContext = {
    permissionRules,
    permissionGate,
    service,
    worktrees: worktreeService,
    status: statusService,
    repository,
    configuration,
    terminals,
    agents,
    sessions,
    archive,
    archivedHistory,
    diffProvider,
    detailView,
    visualStudio,
    reviewPlans,
    runner,
    provisioner,
    tree,
    logger,
    extensionUri: context.extensionUri,
    globalState: context.globalState,
    resolveRepositoryRoot: () => repositoryRoot,
    repositoryUri: () => repositoryUri,
  };
  context.subscriptions.push(...registerCommands(commandContext));

  // If this window was opened as a task worktree awaiting a native Claude chat,
  // launch it now via the official extension, then clear the request.
  void consumePendingNativeChat(context, logger);

  logger.info("Task Workspaces activated.");
}

async function consumePendingNativeChat(
  context: vscode.ExtensionContext,
  logger: OutputChannelLogger,
): Promise<void> {
  const pending = context.globalState.get<string>(PENDING_NATIVE_CHAT_KEY);
  if (!pending) return;

  const normalize = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const matches = (vscode.workspace.workspaceFolders ?? []).some(
    (f) => normalize(f.uri.fsPath) === normalize(pending),
  );
  if (!matches) return;

  await context.globalState.update(PENDING_NATIVE_CHAT_KEY, undefined);
  const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!ext) {
    logger.warn("Pending native chat requested but Claude extension is missing.");
    return;
  }
  try {
    if (!ext.isActive) await ext.activate();
    await vscode.commands.executeCommand(CLAUDE_OPEN_CHAT_COMMAND);
    logger.info("Launched native Claude chat for the opened worktree.");
  } catch (error) {
    logger.error("Failed to launch native Claude chat", error);
  }
}

export function deactivate(): void {
  // Terminal-backed agents are disposed with the window; nothing to clean up.
}
