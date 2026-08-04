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
import { ReportContentProvider, REPORT_SCHEME } from "./ui/reportContentProvider";
import { GitBlobContentProvider, BLOB_SCHEME } from "./ui/gitBlobContentProvider";
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
import { AskUserService, PendingAsk } from "./services/askUserService";
import { ASK_TOOL_ALLOW_RULE } from "./agents/askUserProtocol";
import { recordQuestion } from "./domain/pipelineEngine";
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

  // Reports render from the repository on every read, so one left open follows the
  // stage it describes. `refresh()` is driven from the tree's own change event
  // below — without it VS Code has no reason to re-read the document.
  const reportProvider = new ReportContentProvider((taskId) => repository.get(taskId));
  const blobProvider = new GitBlobContentProvider((worktreePath, revision, filePath) =>
    statusService.showFile(worktreePath, revision, filePath),
  );
  context.subscriptions.push(
    reportProvider,
    blobProvider,
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reportProvider),
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, blobProvider),
  );

  // Holds a refused tool call open until the user decides, so the agent carries
  // on mid-turn instead of the stage being re-run once a rule is added. Created
  // before the tree because the tree renders what it is holding.
  const permissionGate = new PermissionGateService(
    vscode.Uri.joinPath(context.globalStorageUri, "permission-gates").fsPath,
    nodeGateFileSystem,
    logger,
    () => configuration.gateInterpreter(repositoryUri),
    // No gated tools when the feature is off, which writes a settings file with no
    // hook — still needed, because it carries the ask_user allow rule below.
    () =>
      configuration.interactivePermissions(repositoryUri)
        ? configuration.gatedTools(repositoryUri)
        : [],
    () => Math.round(configuration.permissionWaitMinutes(repositoryUri) * 60),
    () => configuration.holdEveryToolCall(repositoryUri),
    // The extension's own question tool. Without a rule the CLI refuses it and the
    // agent reports that it cannot ask, which is the dead end this replaces.
    () =>
      configuration.interactiveQuestions(repositoryUri) ? [ASK_TOOL_ALLOW_RULE] : [],
  );
  context.subscriptions.push({ dispose: () => permissionGate.dispose() });

  // Lets a stage ask the user a question without ending its session, so the answer
  // arrives mid-turn and the subtask does not start again from the beginning.
  const askUser = new AskUserService(
    vscode.Uri.joinPath(context.globalStorageUri, "ask-user").fsPath,
    nodeGateFileSystem,
    logger,
    () => configuration.gateInterpreter(repositoryUri),
  );
  context.subscriptions.push({ dispose: () => askUser.dispose() });

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

  // Any refresh of the tree means a stage may have moved on, so an open report is
  // re-read. Subscribed here rather than at each `tree.refresh()` call site —
  // there are many, and a missed one is an invisibly stale report.
  context.subscriptions.push(tree.onDidChangeTreeData(() => reportProvider.refresh()));

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

  // A live question goes into the same place a NEEDS-INFO one does, so the tree
  // row, the panel and the answer flow are all reused — the only difference is
  // `liveCallId`, which tells the submit handler an agent is still waiting.
  context.subscriptions.push({
    dispose: askUser.onAsked((asked: PendingAsk) => {
      void (async () => {
        const task = await repository.get(asked.taskId);
        if (!task?.pipeline) {
          // Nothing to attach it to; let the agent proceed rather than block.
          askUser.abandon(asked.taskId);
          return;
        }
        const running = task.pipeline.stages.find((stage) =>
          stage.subtasks.some((subtask) => subtask.status === "active"),
        );
        const subtask = running?.subtasks.find((s) => s.status === "active");
        const recorded = recordQuestion(task.pipeline, {
          stageId: running?.id ?? task.pipeline.stages[0]?.id ?? "",
          stageName: running?.name ?? "Stage",
          subtaskId: subtask?.id ?? asked.request.id,
          questions: asked.request.questions,
          at: asked.waitingSince,
          liveCallId: asked.request.id,
        });
        if (!recorded.ok) {
          logger.error(`Could not record a live question: ${recorded.error.message}`);
          askUser.abandon(asked.taskId);
          return;
        }
        await repository.save({
          ...task,
          pipeline: recorded.value,
          updatedAt: new Date().toISOString(),
        });
        tree.refresh();
        logger.info(
          `Harness [${task.name}] is waiting on ${asked.request.questions.length} question(s) — the agent is paused.`,
        );
        // Opened rather than announced: the agent is stopped until it is answered,
        // and a toast for this competes with every other task's toasts.
        await vscode.commands.executeCommand(
          "taskWorkspaces.answerQuestions",
          task.id,
        );
      })();
    }),
  });

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
   * The MCP config any session this extension starts should load.
   *
   * Every session is a fresh CLI, and the CLI starts every server in the config
   * before emitting its first event — nine servers measured at 182 seconds of
   * connect timeouts. When `stageMcpServers` names the ones the work needs, a
   * reduced copy is written to extension storage and passed instead.
   *
   * Applied to task chat sessions as well as route stages. It was stages only, on
   * the reasoning that a chat is exploratory and might want any tool — but the
   * wait is the same, and a person sitting in front of it notices three minutes
   * far more than a subtask does. Clearing the setting is the way back to all of
   * them.
   *
   * Written outside the repository on purpose: it must not appear in a worktree,
   * where it would land in the changed paths the review rules key off. Filtering
   * only removes servers, so this cannot widen what a branch can reach.
   */
  const reducedMcpConfigPath = (taskRepositoryRoot: string): string | undefined => {
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
      mcpConfigPath: reducedMcpConfigPath(task.repositoryRoot),
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
    // Both channels a stage can use to reach the user, installed together because
    // both are per-subtask CLI arguments. Each is separately switchable and each
    // fails soft, so a stage runs with either, both, or neither.
    {
      prepare: (taskId) => {
        const askOn = configuration.interactiveQuestions(repositoryUri);
        const ask = askOn ? askUser.prepare(taskId) : undefined;
        // The settings file is needed by either feature: it installs the hook and
        // carries the ask_user allow rule. Written whenever either is on, and with
        // no gated tools it contains no hook at all.
        const gate =
          configuration.interactivePermissions(repositoryUri) || ask
            ? permissionGate.prepare(taskId)
            : undefined;
        if (!gate && !ask) return undefined;
        return {
          settingsPath: gate?.settingsPath,
          extraMcpConfigPaths: ask ? [ask.mcpConfigPath] : [],
        };
      },
      release: (taskId) => {
        permissionGate.release(taskId);
        // Abandons anything still asked, so a finished stage does not leave the
        // question panel offering to answer a session that has gone.
        askUser.release(taskId);
      },
    },
  );
  /**
   * The project's routes and rules as they are on disk right now.
   *
   * Read per use rather than cached, because the whole point is that editing
   * `harness.json` takes effect on the next stage rather than the next task.
   */
  const currentHarness = () => {
    const root = repositoryUri?.fsPath;
    if (!root) return undefined;
    return loadHarness(root, {
      configuredPath: configuration.harnessConfigPath(repositoryUri),
    });
  };

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
    () => currentHarness(),
  );

  // Lets an open report show a stage's commands as they run, rather than nothing
  // until the subtask ends. Set here because the runner holds the live copy and is
  // built after the providers.
  reportProvider.setLiveActivitySource((taskId) => runner.liveActivity(taskId));
  reportProvider.startAutoRefresh();

  // --- Commands ---------------------------------------------------------
  const commandContext: CommandContext = {
    permissionRules,
    permissionGate,
    askUser,
    stageDefinitions: () => currentHarness() ?? { routes: [], rules: [] },
    reducedMcpConfigPath,
    mcpNarrowed: () => configuration.stageMcpServers(repositoryUri).length > 0,
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
    reportProvider,
    blobProvider,
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
