import * as vscode from "vscode";
import { OutputChannelLogger } from "./logging/outputChannelLogger";
import { GitClient } from "./git/gitClient";
import { GitStatusService } from "./git/gitStatusService";
import { GitWorktreeService } from "./git/gitWorktreeService";
import { GitMergeService } from "./git/gitMergeService";
import { ExtensionStateTaskRepository } from "./persistence/extensionStateTaskRepository";
import { NodeStateFileLock } from "./persistence/nodeStateFileLock";
import { NodeStateFileIo } from "./persistence/nodeStateFileIo";
import { RoutedTaskRepository, TaskStateStore } from "./persistence/taskStateStore";
import { TaskWorkspaceService } from "./services/taskWorkspaceService";
import { ExtensionConfiguration } from "./configuration/extensionConfiguration";
import { TerminalManager } from "./processes/terminalManager";
import { AgentProviderRegistry } from "./agents/agentProviderRegistry";
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
import { SuggestionScanService } from "./services/suggestionScanService";
import { SuggestionScanSessionRunner } from "./agents/suggestionScanSessionRunner";
import { describeRuleAdditions } from "./domain/ruleConfirmation";
import { NodeVerificationRunner } from "./services/nodeVerificationRunner";
import { ExternalFeedbackService } from "./services/externalFeedbackService";
import { feedbackWaitingSince, Housekeeping } from "./services/housekeeping";
import { ProtocolSkillInstaller } from "./services/protocolSkillInstaller";
import { buildStageRuntime } from "./services/stageRuntime";
import { SERVER_BUNDLE_DIR, installServerBundle } from "./services/serverBundleInstaller";
import { RunLeaseService } from "./services/runLeaseService";
import { STATE_FILE_NAME, taskStateDir } from "./persistence/taskStateFile";
import {
  SUGGESTION_SCAN_FILE_NAME,
  SuggestionScanFileStore,
} from "./persistence/suggestionScanFile";
import { StateFileWatch, watchStateFile } from "./persistence/stateFileWatcher";
import { WorktreeProvisioner } from "./services/worktreeProvisioner";
import { PermissionRulesService } from "./services/permissionRulesService";
import { suggestAllowRule, suggestAllowRules } from "./agents/permissionDenials";
import { PendingGate } from "./services/permissionGateService";
import { nextAnnouncements } from "./domain/permissionGatePolicy";
import { recordInterjection } from "./domain/pipelineEngine";
import { QuestionPanel } from "./ui/questionPanel";
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
  const mergeService = new GitMergeService(gitClient);
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
    // The state file is shared by every worktree of a repository and by a
    // headless run, so the repository's own mutation queue — which serialises
    // this host and nothing else — is only half the guarantee.
    createLock: (stateFilePath) => new NodeStateFileLock(stateFilePath, logger),
  });
  // Declared before `repositoryRoot` exists, and read on every call, because the
  // active repository is resolved after the service graph is built and can
  // change while the window is open.
  /**
   * Resolves once the active repository is known. Assigned below, where resolution is
   * started; read here because every task read has to wait for it.
   */
  let repositoryReady: Promise<void> | undefined;
  const repository = new RoutedTaskRepository(async () => {
    // Awaited before concluding there is no repository, and this is load-bearing.
    // Resolution is deliberately not awaited at activation — it is git spawns plus a
    // skill write, and awaiting it delayed the tree, the views and every command
    // registration behind it. But `repositoryRoot` is undefined until it finishes, so
    // for the first second or so of a window every read fell through to the Memento —
    // which is a *backup*, not the source of truth. A command run in that window looked
    // up its task, did not find it there, and returned silently: right-click "Re-run
    // This Stage…" showed "Activating Extensions…" and then nothing at all.
    //
    // Worse than the silence, `save` routed the same way, so a write in that window
    // would have landed in the backup while the state file held the truth. Waiting is
    // the whole fix, and it belongs here rather than in each command: this is the one
    // place that knows the answer is not ready yet.
    if (repositoryReady) await repositoryReady;
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

  // Hosts such as Claude Desktop start the harness MCP server by path. Pointed into this
  // versioned install folder, they kept running the release they were configured
  // against; the global storage copy has no version in its path. See
  // `services/serverBundleInstaller.ts`.
  const serverBundle = installServerBundle(
    vscode.Uri.joinPath(context.extensionUri, "dist").fsPath,
    vscode.Uri.joinPath(context.globalStorageUri, SERVER_BUNDLE_DIR).fsPath,
    logger,
    undefined,
    // Versioned, so an editor on an older release never puts its server back over one
    // `harnessRunner update` downloaded since.
    { version: String(context.extension.packageJSON.version) },
  );
  if (serverBundle) {
    logger.info(
      `Harness MCP server: ${serverBundle.server}` +
        (serverBundle.updated.length > 0 ? ` (updated ${serverBundle.updated.join(", ")})` : ""),
    );
  }

  const skillInstaller = new ProtocolSkillInstaller(logger);
  /** Where the harness's protocol skill lives, once a repository is resolved. */
  let protocolPluginDir: string | undefined;

  // Fired when the state file is replaced by another process — a headless run, or
  // Claude through the harness MCP server. An emitter rather than a direct call
  // because the tree it refreshes is built after this, and re-armed per resolved
  // repository because the state file belongs to the repository, not the window.
  const stateFileChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(stateFileChanged);
  // An event rather than a direct call: the repository resolves before the scan service
  // and the tree are built, so a closure naming them could run before they exist.
  const scanFileChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(scanFileChanged);
  let stateFileWatch: StateFileWatch | undefined;
  context.subscriptions.push({ dispose: () => stateFileWatch?.dispose() });
  // A scan Claude ran lands in this file; watched so the tree shows it without a scan here.
  let scanFileWatch: StateFileWatch | undefined;
  context.subscriptions.push({ dispose: () => scanFileWatch?.dispose() });

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

    // Installed once per resolved repository, not per stage: it goes under the git
    // common dir, so every worktree of this repository shares the one copy. Resolved
    // here because `optionsFor` below is synchronous and the git call is not.
    protocolPluginDir = undefined;
    stateFileWatch?.dispose();
    stateFileWatch = undefined;
    scanFileWatch?.dispose();
    scanFileWatch = undefined;
    if (repositoryRoot) {
      const commonDir = await worktreeService.getGitCommonDir(repositoryRoot);
      if (commonDir.ok) {
        protocolPluginDir = skillInstaller.install(taskStateDir(commonDir.value))?.pluginDir;
        stateFileWatch = watchStateFile(
          taskStateDir(commonDir.value),
          STATE_FILE_NAME,
          () => stateFileChanged.fire(),
          logger,
        );
        scanFileWatch = watchStateFile(
          taskStateDir(commonDir.value),
          SUGGESTION_SCAN_FILE_NAME,
          () => scanFileChanged.fire(),
          logger,
        );
        scanFileChanged.fire();
      }
    }
  };

  // Not awaited. Resolving the repository is git spawns plus a skill write, and every
  // consumer of `repositoryRoot` reads it through a closure — so awaiting here bought
  // nothing and delayed the tree, the views and every command registration behind it.
  // Activation is the one path where that cost shows up as the extension being dead.
  // The three places below that genuinely need a resolved root chain onto this promise.
  repositoryReady = resolveRepository();

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
    // Rule-added stages are the only ones the user never chose: they pick a route,
    // and the engine then appends agent sessions to it off a derived path set. Fine
    // for one obvious review, and how four unrelated ones came to run on a one-line
    // change. Modal, because the alternative is the route starting them while the
    // notification is still on screen.
    async (request) => {
      const detail =
        `${describeRuleAdditions(request.added, request.matches)}\n\n` +
        `Matched against ${request.changedPathCount} changed path(s). If that number ` +
        `looks wrong for this task, so are these reviews.`;
      const choice = await vscode.window.showWarningMessage(
        `"${request.task.name}": review rules want to add ${request.added.length} ` +
          `stages, each a separate agent session.`,
        { modal: true, detail },
        "Add Them",
        "Not Now",
      );
      // Dismissing is not consent. A modal returns undefined on Escape, and the
      // expensive reading of that is "go ahead".
      return choice === "Add Them";
    },
  );

  const permissionRules = new PermissionRulesService(logger);
  // Shared: also used when granting a rule, to refresh an existing worktree's copy.
  const provisioner = new WorktreeProvisioner(logger);

  // Everything that runs a stage, built by the same code a headless runner uses
  // (`services/stageRuntime.ts`), so the two cannot drift. What stays here is what
  // only VS Code can do: show a refusal to the person in front of it.
  const runtime = buildStageRuntime({
    logger,
    settings: () => configuration.settings(repositoryUri),
    storageDir: context.globalStorageUri.fsPath,
    repositoryRoot: () => repositoryRoot,
    configRoot: () => repositoryUri?.fsPath,
    protocolPluginDir: () => protocolPluginDir,
    repository,
    reviewPlans,
    gitClient,
    statusService,
    worktreeService,
    liveRequests: {
      onQuestionRecorded: (task) => {
        tree.refresh();
        // Opened rather than announced: the agent is stopped until it is answered,
        // and a toast for this competes with every other task's toasts.
        void vscode.commands.executeCommand("taskWorkspaces.answerQuestions", task.id);
      },
      onAnswersDelivered: (task, { live }) => {
        QuestionPanel.update(task.id, undefined);
        tree.refresh();
        if (!live && configuration.advanceAfterAnswering(repositoryUri)) {
          void vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
        }
      },
    },
    onUnheldDenial: (task, denial) => {
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
  });
  context.subscriptions.push({ dispose: () => runtime.dispose() });
  const {
    agentProcesses,
    sessions,
    permissionGate,
    askUser,
    reducedMcpConfigPath,
    currentHarness,
    worktreeDiscards,
    worktreeClaims,
    runner,
  } = runtime;

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
    // Thrown rather than flattened to `[]`. An empty array is a real answer — a
    // checkout with no files — and returning it for a git failure is what let one
    // failed listing be cached as "no solution here", so the command opened the folder
    // instead of the .sln from then on. `detect` declines to cache what it could not
    // read, and it can only do that if the failure reaches it.
    if (!result.ok) {
      throw new Error(
        `Could not list files in ${worktreePath}: ${
          result.error.kind === "git" ? result.error.error.message : result.error.message
        }`,
      );
    }
    return result.value;
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


  // Counted when the message actually reaches a stage, not when it is typed: an
  // interjection the session finished before receiving cost the route nothing, and
  // this is the number the harness is judged on. Attributed to the running stage,
  // which is the one it interrupted.
  permissionGate.onInterjectionDelivered = async (interjection) => {
    const task = await repository.get(interjection.taskId);
    if (!task?.pipeline) return;
    const running = task.pipeline.stages.find((stage) => stage.status === "active");
    await repository.save({
      ...task,
      pipeline: recordInterjection(task.pipeline, running?.id, interjection.at),
    });
    tree.refresh();
  };


  // --- Tree view --------------------------------------------------------
  // Declared before the tree and assigned after the stage runner exists: the tree only
  // ever reads the last scan, and a scan needs a session runner that is built later.
  let suggestionScans: SuggestionScanService | undefined;

  // Bound once the pipeline runner exists, which is after the tree: a render can
  // happen in between, and reading the runner's binding then would throw.
  let isDrivingRoute: (taskId: string) => boolean = () => false;
  const tree = new TaskWorkspaceTreeProvider(
    service,
    () => repositoryRoot,
    logger,
    (task) => {
      // A built-in chat session (which we drive) is authoritative.
      const session = sessions.get(task.id);
      const driving = isDrivingRoute(task.id);
      if (session || driving) {
        return deriveAgentActivity(session?.status, session?.busy ?? false, driving);
      }
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
    // Read fresh on every render, so adding a source to harness.json shows up without
    // a window reload — the same way routes and rules are re-read.
    (root) =>
      loadHarness(root, {
        configuredPath: configuration.harnessConfigPath(repositoryUri),
      }).suggestionSources,
    (root) => suggestionScans?.lastScan(root),
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
      const driving = isDrivingRoute(taskId);
      return session || driving
        ? deriveAgentActivity(session?.status, session?.busy ?? false, driving)
        : undefined;
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
  // A write by another client. The detail view and any open report follow, since both
  // already re-read on every tree refresh.
  context.subscriptions.push(stateFileChanged.event(() => tree.refresh()));

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

  const suggestionScanStore = new SuggestionScanFileStore(new NodeStateFileIo(), async (root) => {
    const commonDir = await worktreeService.getGitCommonDir(root);
    return commonDir.ok ? taskStateDir(commonDir.value) : undefined;
  });
  suggestionScans = new SuggestionScanService(
    new SuggestionScanSessionRunner(runtime.scanRunner, { now: () => new Date().toISOString() }),
    { now: () => new Date().toISOString() },
    suggestionScanStore,
  );
  context.subscriptions.push(
    scanFileChanged.event(() => {
      if (!repositoryRoot) return;
      void suggestionScans?.load(repositoryRoot).then(() => tree.refresh());
    }),
  );
  if (repositoryRoot) scanFileChanged.fire();

  isDrivingRoute = (taskId) => runner.isRunning(taskId);

  // The watchdog for a host that died mid-subtask. Every mechanism that ends a
  // subtask lives in the owning host's memory — the session's status listener, the
  // per-subtask timeout, the driver awaiting the run — so a host that goes takes
  // all three with it and leaves the record `active` with no reply, no activity and
  // no cost. Nothing detected that: the route was not running, so no advance was
  // there to reclaim it, and Stop wrote nothing. A task stayed wedged until someone
  // noticed by eye, which is how one sat for two hours.
  //
  // A sweep rather than a timer, precisely because the timer is what died. It reads
  // the state file, so it recovers work abandoned by a host that no longer exists —
  // including on the first pass at activation, which is the common case: the host
  // that died is usually the one this one replaced.
  // This host's claim on a route while it advances one (`domain/runLease.ts`), so a
  // headless runner and this window never drive the same task at once.
  const leases = new RunLeaseService(repository, "vscode");

  // The background repairs, shared with `harnessRunner tick` so they run whichever
  // client is open (`services/housekeeping.ts`). What stays here is the timers and
  // what only VS Code can do: tell the person in front of it.
  const externalFeedback = new ExternalFeedbackService({
    repository,
    runner: new NodeVerificationRunner(),
    sources: (root) =>
      loadHarness(root, {
        configuredPath: configuration.harnessConfigPath(repositoryUri),
      }).suggestionSources,
    waitingSince: feedbackWaitingSince,
    clock: { now: () => new Date().toISOString() },
    logger,
  });
  const housekeeping = new Housekeeping({
    repository,
    runner,
    leases,
    feedback: externalFeedback,
    agentProcesses,
    definitions: () => currentHarness(),
    feedbackPollMinutes: () => configuration.feedbackPollMinutes(repositoryUri),
    logger,
    now: () => new Date().toISOString(),
  });

  // The watchdog for a host that died mid-subtask. A sweep rather than a timer,
  // precisely because the timer is what died — and run at activation, because the
  // host that died is usually the one this one replaced.
  const sweepStaleSubtasks = async (): Promise<void> => {
    if (!repositoryRoot) return;
    const recovered = await housekeeping.reclaimStale(repositoryRoot);
    if (recovered === 0) return;
    tree.refresh();
    // Notified, not merely logged: the user is owed the reason a stage they
    // watched start is pending again, and the answer — re-run it — is theirs.
    void vscode.window
      .showWarningMessage(
        `${recovered} stage subtask(s) had been left running by a session that is gone. ` +
          "They are pending again — Advance Route re-runs them.",
        "Show Log",
      )
      .then((choice) => {
        if (choice === "Show Log") logger.show?.();
      });
  };
  void repositoryReady.then(() => sweepStaleSubtasks());
  const staleSweep = setInterval(() => void sweepStaleSubtasks(), 10 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(staleSweep) });

  // A chained timeout rather than an interval, so a change to the setting applies from
  // the next poll without a reload, and `0` stops it until somebody sets a number again.
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  const pollFeedback = async (): Promise<void> => {
    if (repositoryRoot) {
      const arrived = await housekeeping.pollFeedback(repositoryRoot);
      if (arrived.length > 0) {
        tree.refresh();
        const names = arrived.map((task) => task.origin?.ref ?? task.name).join(", ");
        void vscode.window.showInformationMessage(
          `New ticket comment(s) on ${names} — moved back to Needs you.`,
        );
      }
    }
    const minutes = configuration.feedbackPollMinutes(repositoryUri);
    feedbackTimer = setTimeout(() => void pollFeedback(), Math.max(minutes, 1) * 60 * 1000);
  };
  void repositoryReady.then(() => pollFeedback());
  context.subscriptions.push({ dispose: () => feedbackTimer && clearTimeout(feedbackTimer) });

  // Logged by the pass itself rather than notified: unlike a reclaimed subtask this asks
  // nothing of the user and discards nothing.
  const syncGateDeclarations = async (): Promise<string[]> => {
    if (!repositoryRoot) return [];
    const corrected = await housekeeping.syncRouteConfig(repositoryRoot);
    if (corrected.length > 0) tree.refresh();
    return corrected;
  };

  void repositoryReady.then(() => syncGateDeclarations());
  // At activation only here: the records this window writes can only lose their owner
  // to a host restart. `harnessRunner tick` covers a repository nobody opens VS Code on.
  void repositoryReady.then(async () => {
    if (repositoryRoot) await housekeeping.sweepAgentProcesses(repositoryRoot);
  });
  // Watched as a *file*, because that is what it is. `onDidChangeConfiguration` fires for
  // VS Code settings and never for `harness.json`, so hooking it would have looked
  // correct and only ever run at activation — which is the same class of mistake as the
  // bug this repairs. Editing the route file is the moment a user expects a new audience
  // to take effect.
  void repositoryReady.then(() => {
    if (!repositoryRoot) return;
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repositoryRoot, ".taskworkspaces/*.json"),
    );
    configWatcher.onDidChange(() => void syncGateDeclarations());
    configWatcher.onDidCreate(() => void syncGateDeclarations());
    context.subscriptions.push(configWatcher);
    // The same pass on demand, and reported rather than logged.
    //
    // The watcher above covers the case it was built for — you edit `harness.json` with
    // the window open — and leaves two it cannot. An edit made while this window was
    // closed reaches tasks only at the next activation, and a pass that runs silently
    // and corrects nothing is indistinguishable from one that did not fire, which is
    // exactly the question an operator has after editing a route: *did that land?*
    // Answering it today means advancing a task and watching how a stage behaves.
    //
    // It reports what changed, and says so when nothing did. Nothing changing is the
    // common and correct outcome — a repository already in line — and it is also what a
    // broken config file looks like, so the two must not both be silence.
    context.subscriptions.push(
      vscode.commands.registerCommand("taskWorkspaces.syncRouteConfig", async () => {
        const corrected = await syncGateDeclarations();
        if (corrected.length === 0) {
          void vscode.window.showInformationMessage(
            "Every task already matches harness.json. Nothing changed.",
          );
          return;
        }
        const shown = await vscode.window.showInformationMessage(
          `Reloaded route config into ${corrected.length} task(s).`,
          "Show Details",
        );
        if (shown === "Show Details") logger.show();
      }),
    );
    // The tree rendered against no repository while this was resolving, so it has to be
    // told the root now exists — otherwise the view says "open a git repository" until
    // something else happens to refresh it.
    tree.refresh();
  });

  // Lets an open report show a stage's commands as they run, rather than nothing
  // until the subtask ends. Set here because the runner holds the live copy and is
  // built after the providers.
  reportProvider.setLiveActivitySource((taskId) => runner.liveActivity(taskId));
  reportProvider.startAutoRefresh();

  // --- Commands ---------------------------------------------------------
  const commandContext: CommandContext = {
    leases,
    onStateFileChanged: (listener) => stateFileChanged.event(listener),
    permissionRules,
    permissionGate,
    askUser,
    suggestionScans,
    feedback: externalFeedback,
    stageDefinitions: () => currentHarness() ?? { routes: [], rules: [] },
    reducedMcpConfigPath,
    mcpNarrowed: () => configuration.stageMcpServers(repositoryUri).length > 0,
    service,
    worktrees: worktreeService,
    status: statusService,
    merges: mergeService,
    discards: worktreeDiscards,
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
    worktreeClaims,
    provisioner,
    tree,
    logger,
    extensionUri: context.extensionUri,
    globalState: context.globalState,
    resolveRepositoryRoot: () => repositoryRoot,
    repositoryUri: () => repositoryUri,
  };
  context.subscriptions.push(...registerCommands(commandContext));

  // Requests from a client outside VS Code — answers to deliver, a route to advance —
  // arrive as state file changes. Served once at start too, for any filed while no
  // window was open.
  const serveLiveRequests = (): void => {
    if (repositoryRoot) void runtime.liveRequests.serve(repositoryRoot);
  };
  context.subscriptions.push(stateFileChanged.event(serveLiveRequests));
  void repositoryReady?.then(serveLiveRequests);

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
