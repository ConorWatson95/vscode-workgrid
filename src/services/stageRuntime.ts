import * as fs from "node:fs";
import * as path from "node:path";
import { ClaudeStageSessionRunner } from "../agents/stageSessionRunner";
import { AgentSessionManager } from "../agents/agentSessionManager";
import { ASK_TOOL_ALLOW_RULE } from "../agents/askUserProtocol";
import { resolveMcpConfigPath } from "../agents/claudeCliArgs";
import { filterMcpConfig } from "../agents/mcpConfigFilter";
import { PermissionDenial } from "../agents/permissionDenials";
import { HarnessSettings } from "../configuration/harnessSettings";
import { askTimeoutEnv, askTimeoutMs } from "../domain/askTimeout";
import { Contamination, distinctiveLines } from "../domain/branchContamination";
import { stageTools } from "../domain/stageTools";
import { subagentLimitEnv } from "../domain/subagentLimits";
import { SCAN_DISALLOWED_TOOLS, SCAN_TIMEOUT_MS } from "../agents/suggestionScanSessionRunner";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { parsePorcelainChanges } from "../domain/worktreeDiscard";
import { GitClient } from "../git/gitClient";
import { GitStatusService } from "../git/gitStatusService";
import { GitWorktreeService } from "../git/gitWorktreeService";
import { Logger } from "../logging/logger";
import { TaskRepository } from "../persistence/taskRepository";
import { AskUserService } from "./askUserService";
import { LiveRequestBridge, LiveRequestBridgeOptions } from "./liveRequestBridge";
import { nodeGateFileSystem } from "./gateFileSystem";
import { NodeVerificationRunner } from "./nodeVerificationRunner";
import { PermissionGateService } from "./permissionGateService";
import { PipelineRunner } from "./pipelineRunner";
import { PullRequestWaitService } from "./pullRequestWaitService";
import { ReviewPlanService } from "./reviewPlanService";
import { loadHarness } from "./reviewRulesService";
import { SessionProcessRegistry } from "./sessionProcessRegistry";
import { TaskCommitService } from "./taskCommitService";
import { WorktreeClaimService, gitWorktreeClaimPort } from "./worktreeClaimService";
import { WorktreeDiscardService } from "./worktreeDiscardService";

/**
 * Everything a process needs to run route stages, built the same way wherever it runs.
 *
 * This wiring lived in `extension.ts`, which made the extension the only thing that
 * could advance a route: every service it composes was already free of `vscode`, and
 * only the composition was not. Moved here so a headless runner (`runner/main.ts`)
 * builds a runner identical to the extension's — same session options, same
 * permission gate, same checks — rather than a second copy that drifts. The comments
 * on each argument are the reasons they were added and travel with them.
 *
 * What stays with the host is what only a host can do: show a refusal to a person
 * (`onUnheldDenial`), and decide where machine-local storage lives (`storageDir`).
 */
export interface StageRuntimeOptions {
  logger: Logger;
  /** Read per use, so a changed setting applies to the next stage. */
  settings: () => HarnessSettings;
  /**
   * Machine-local storage for inboxes, the process registry and the reduced MCP
   * config. Never inside the repository: a file written in a worktree lands in the
   * changed paths the review rules key off.
   */
  storageDir: string;
  /** The repository whose tasks this runtime drives. */
  repositoryRoot: () => string | undefined;
  /** Where `harness.json` is looked for — the workspace folder in VS Code. */
  configRoot: () => string | undefined;
  /** The installed protocol skill's plugin directory, once there is one. */
  protocolPluginDir: () => string | undefined;
  repository: TaskRepository;
  reviewPlans: ReviewPlanService;
  gitClient: GitClient;
  statusService: GitStatusService;
  worktreeService: GitWorktreeService;
  /**
   * A refused tool call the permission gate will not hold for the user. The host
   * shows it; a host with nobody to show it to leaves it to the log and the stage row.
   */
  onUnheldDenial?: (task: TaskWorkspace, denial: PermissionDenial) => void;
  /**
   * How this host takes part in carrying questions and held calls to other clients
   * (`liveRequestBridge.ts`). The bridge itself is always built: a stage either host
   * runs must be answerable from the dashboard.
   */
  liveRequests?: Pick<LiveRequestBridgeOptions, "servesBrief" | "onQuestionRecorded" | "onAnswersDelivered">;
}

export type StageRuntime = ReturnType<typeof buildStageRuntime>;

export function buildStageRuntime(options: StageRuntimeOptions) {
  const {
    logger,
    settings,
    repository,
    reviewPlans,
    gitClient,
    statusService,
    worktreeService,
  } = options;

  // Durable record of what was spawned, so an extension host that crashes -- where
  // `dispose()` never runs -- does not leave a stage session alive with nothing able
  // to reach it. Machine-local beside the permission gate root, never in the state
  // file: a pid is ephemeral and that file is shared by every worktree and window.
  const agentProcesses = new SessionProcessRegistry({
    directory: path.join(options.storageDir, "agent-processes"),
    logger,
    // Read lazily: the root is resolved after this is built. It scopes the sweep,
    // whose `active` set can only ever come from this repository -- see
    // `SessionProcessRecord.repositoryRoot`.
    repositoryRoot: options.repositoryRoot,
  });
  const sessions = new AgentSessionManager(
    logger,
    () => settings().claudeCommand(),
    agentProcesses,
  );

  // Holds a refused tool call open until the user decides, so the agent carries
  // on mid-turn instead of the stage being re-run once a rule is added. Created
  // before the tree because the tree renders what it is holding.
  const permissionGate = new PermissionGateService(
    path.join(options.storageDir, "permission-gates"),
    nodeGateFileSystem,
    logger,
    () => settings().gateInterpreter(),
    // No gated tools when the feature is off, which writes a settings file with no
    // hook — still needed, because it carries the ask_user allow rule below.
    () =>
      settings().interactivePermissions()
        ? settings().gatedTools()
        : [],
    () => Math.round(settings().permissionWaitMinutes() * 60),
    () => settings().holdEveryToolCall(),
    // The extension's own question tool. Without a rule the CLI refuses it and the
    // agent reports that it cannot ask, which is the dead end this replaces.
    () =>
      settings().interactiveQuestions() ? [ASK_TOOL_ALLOW_RULE] : [],
    undefined,
    // The other half of `worktree.discardPaths`. The discard keeps a stage's check from
    // failing on a transformed `Web.config`; it runs after the session, so it has never
    // been able to keep that file out of the commit the session just made. This refuses a
    // `git add -A` / `git commit -a` that would sweep one in, while letting the file be
    // named explicitly — see `domain/stagedEnvironmentPaths.ts`.
    //
    // `currentHarness` is declared further down and only ever called from a sweep, which
    // cannot run before a stage has been prepared — long after activation returns.
    () => currentHarness()?.discardPaths ?? [],
    async (cwd) => {
      // `status.relativePaths=false` because the CLI's cwd may be a subdirectory of the
      // worktree, and git would otherwise report paths relative to *it* — which would
      // silently stop matching a repository-relative declaration. The discard service
      // needs no such flag: it is handed the worktree root.
      const status = await gitClient.run(
        ["-c", "status.relativePaths=false", "status", "--porcelain"],
        { cwd },
      );
      return status.ok ? parsePorcelainChanges(status.value.stdout) : undefined;
    },
  );


  // Lets a stage ask the user a question without ending its session, so the answer
  // arrives mid-turn and the subtask does not start again from the beginning.
  const askUser = new AskUserService(
    path.join(options.storageDir, "ask-user"),
    nodeGateFileSystem,
    logger,
    () => settings().gateInterpreter(),
    undefined,
    // The same setting that sets `MCP_TOOL_TIMEOUT`, declared again as this server's
    // own idle timeout: the CLI bounds elapsed time and silence separately, and a
    // question blocking by design is bounded by the silence one. Raising only the
    // first is why questions kept dying in about seven minutes.
    // Through `askTimeoutMs`, not multiplied here: zero means "wait indefinitely" and
    // multiplying it out would expire every question the instant it was asked.
    () => askTimeoutMs(settings().askTimeoutMinutes()),
  );

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
      settings().mcpConfigPath(),
      (p) => fs.existsSync(p),
    );
    if (!resolved) return undefined;

    const allow = settings().stageMcpServers();
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

      const directory = path.join(options.storageDir, "stage-mcp");
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, "mcp.json");
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
      permissionMode: settings().permissionMode(),
      addDirs: [task.repositoryRoot],
      // A stage session runs in a worktree the CLI has never seen, so the
      // project's MCP servers are unapproved there and silently absent — which
      // is how a planning stage loses the ability to read its own ticket.
      mcpConfigPath: reducedMcpConfigPath(task.repositoryRoot),
      // Enforced, not merely offered: without strict mode the worktree's own
      // approved `.mcp.json` starts every server anyway, and a reduced config
      // achieves nothing. Only when the set was narrowed on purpose, since strict
      // mode also drops the user's own user-scope servers.
      strictMcpConfig: settings().stageMcpServers().length > 0,
      autoCompactThreshold: settings().autoCompactThreshold(),
      contextStrategy: settings().contextStrategy(),
      model: settings().model(),
      taskName: task.name,
      // Stage sessions only. A chat session the user is driving keeps the CLI's
      // own defaults: this cap protects concurrent tasks from each other, and a
      // hand-driven session has no concurrent tasks to protect.
      // Stage sessions only. A chat session the user drives keeps whatever skills
      // they have configured; the protocol skill describes how to behave as a stage,
      // which a hand-driven session is not.
      pluginDirs: options.protocolPluginDir() ? [options.protocolPluginDir()!] : undefined,
      env: {
        ...subagentLimitEnv({
          concurrency: settings().stageSubagentConcurrency(),
          depth: settings().stageSubagentDepth(),
        }),
        // A stage blocked on `ask_user` is waiting for a person, not hung. On the CLI's
        // own tool timeout the call fails after a few minutes and the agent answers its
        // own question — so the wait has to be set to human latency, not machine.
        ...askTimeoutEnv(settings().askTimeoutMinutes()),
      },
    }),
    logger,
    settings().stageTimeoutMinutes() * 60 * 1000,
    // Both channels a stage can use to reach the user, installed together because
    // both are per-subtask CLI arguments. Each is separately switchable and each
    // fails soft, so a stage runs with either, both, or neither.
    {
      prepare: (taskId) => {
        const askOn = settings().interactiveQuestions();
        const ask = askOn ? askUser.prepare(taskId) : undefined;
        // The settings file is needed by either feature: it installs the hook and
        // carries the ask_user allow rule. Written whenever either is on, and with
        // no gated tools it contains no hook at all.
        const gate =
          settings().interactivePermissions() || ask
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
        // question panel offering to answer a session that has gone. The count is
        // returned rather than discarded: a question still waiting here was never
        // answered by anyone, and the runner fails the subtask on it.
        return askUser.release(taskId);
      },
    },
    // Read per run so widening it takes effect on the next stage, not the next
    // window. Stage sessions only — the ad-hoc chat runners below pass nothing and
    // keep the CLI's full set, because a person is not a stage.
    () => stageTools(settings().additionalStageTools()),
    // The stage timeout bounds a hung CLI, and a stage blocked on `ask_user` is not
    // hung. Without this the shorter of the two settings always won, so a question
    // could never outlive `stageTimeoutMinutes` however long `askTimeoutMinutes` was —
    // and the stage was then recorded as having timed out rather than as having waited.
    (taskId) => askUser.blockedMs(taskId),
  );

  // A scan is a stage session with no task, rooted at the repository — the same runner
  // class, so it inherits MCP readiness abandoning a scan whose ticket server is
  // unavailable before any inference is paid for, the hard timeout, and the failure
  // logging. What it does *not* inherit is a stage's environment, and each difference is
  // deliberate:
  //
  //  * **No permission gate.** A scan holds nothing for approval because it is read-only
  //    and nobody is waiting to grant anything mid-list-refresh.
  //  * **No protocol skill.** The skill teaches an engine to speak VERDICT, DEFERRED and
  //    HANDOFF, none of which a scan emits — it has its own reply contract. Loading it
  //    was prefix tokens spent teaching a scan a protocol it cannot use.
  //  * **No tools that change anything.** Enforced rather than requested: the first real
  //    scan wrote three Bash commands to parse an MCP result, had each refused, and cost
  //    $0.89 across eight turns instead of $0.49 across three. An agent that never had
  //    the tool does the work with what it has, which is the same reasoning
  //    `subagentLimits` applies to the Agent tool.
  const scanRunner = new ClaudeStageSessionRunner(
    sessions,
    (task) => ({
      worktreePath: task.worktreePath,
      permissionMode: settings().permissionMode(),
      mcpConfigPath: reducedMcpConfigPath(task.repositoryRoot),
      strictMcpConfig: settings().stageMcpServers().length > 0,
      // The source's own model wins, applied per run by the scan service; this is only
      // the fallback for a source that names none.
      model: settings().model(),
      taskName: task.name,
      autoCompactThreshold: 0,
      disallowedTools: SCAN_DISALLOWED_TOOLS,
    }),
    logger,
    SCAN_TIMEOUT_MS,
  );
  /**
   * The project's routes and rules as they are on disk right now.
   *
   * Read per use rather than cached, because the whole point is that editing
   * `harness.json` takes effect on the next stage rather than the next task.
   */
  const currentHarness = () => {
    const root = options.configRoot();
    if (!root) return undefined;
    return loadHarness(root, {
      configuredPath: settings().harnessConfigPath(),
    });
  };

  /**
   * Restores the paths the project declared to be local environment before a stage's
   * check reads the tree. Empty config means it never does anything.
   */
  const worktreeDiscards = new WorktreeDiscardService(
    gitClient,
    () => currentHarness()?.discardPaths ?? [],
    logger,
  );


  /**
   * Keeps the record of which worktrees each task holds.
   *
   * Stages create worktrees the extension never made — a `promote/<ticket>-uat` tree, a
   * publish tree — so nothing cleaned them up and nothing could tell that two tasks
   * were promoting through the same one. The port is narrow on purpose: every decision
   * is in `domain/worktreeLease.ts`, and this is the git it needs.
   */
  const worktreeClaims = new WorktreeClaimService(
    gitWorktreeClaimPort(worktreeService, statusService),
    repository,
    logger,
  );

  const taskCommits = new TaskCommitService(repository, statusService, logger);
  const pullRequestWaits = new PullRequestWaitService(gitClient, statusService, logger);

  const runner = new PipelineRunner(
    stageRunner,
    repository,
    reviewPlans,
    logger,
    () => settings().projectDocsPath(),
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
        settings().interactivePermissions() &&
        permissionGate.isArmed(task.id) &&
        settings().gatedTools()
          .some((tool) => tool.toLowerCase() === denial.tool.toLowerCase());
      if (gateWillHoldRetry) return;
      options.onUnheldDenial?.(task, denial);
    },
    () => settings().pauseOnPermissionDenial(),
    // Read per advance rather than cached: editing a stage's model in
    // harness.json should take effect on the next stage, not the next task.
    () => currentHarness(),
    // Read from the worktree itself, so a stage that checked out another branch is
    // caught before the next stage reports on the wrong tree.
    async (worktreePath) => {
      const current = await worktreeService.getCurrentBranch(worktreePath);
      return current.ok ? current.value : undefined;
    },
    // Turns a stage's declared check into its outcome, so "done" stops meaning
    // "the session ended without error".
    new NodeVerificationRunner(),
    // Reads a stage's plan out of the worktree, so its numbered steps can be held
    // against it one by one. Absent file and unreadable file are the same answer
    // here: either way there is no plan to account for, and the runner refuses to
    // run the stage rather than letting it improvise.
    async (worktreePath, relativePath) => {
      try {
        return await fs.promises.readFile(path.join(worktreePath, relativePath), "utf8");
      } catch {
        return undefined;
      }
    },
    worktreeClaims,
    // How long this task's stages have been held waiting on an answer. Sampled either
    // side of each subtask, so the operator's thinking time stops being recorded as
    // the model working — see `domain/humanWait.ts`.
    (taskId) => askUser.humanWaitMs(taskId),
    // Past this, an `active` subtask no live run owns is assumed abandoned. The
    // stage timeout plus a margin, because a live owner would have failed it at
    // the timeout — so anything older has no owner left to come back for it.
    () => settings().stageTimeoutMinutes() * 60 * 1000 + 5 * 60 * 1000,
    // Restores the tracked paths `worktree.discardPaths` declares to be local
    // environment, so a stage's check stops failing on a transformed Web.config and
    // tracked build output while the work is committed and pushed. Read per stage from
    // the repository root, so a branch cannot add to the list of files deleted on its
    // own way past a gate.
    (worktreePath, signal) => worktreeDiscards.discard(worktreePath, signal),
    // How many times a subtask whose session died on the transport is simply run
    // again. Read per failure, so an operator who has had enough of an outage can
    // set it to 0 without a restart and get the old behaviour: held on the first
    // occurrence rather than retried.
    () => settings().transientRetryAttempts(),
    // The backoff between those attempts keeps its default. Named as a hole rather than
    // omitted, because the next argument is positional and this constructor now has
    // enough parameters that a silent shift is the likely mistake — one happened while
    // adding the argument below.
    undefined,
    // Amendment subtasks only, and only when configured — see `resolveAmendmentModel`
    // for the measurement. Last, because every argument here is positional.
    () => settings().amendmentModel(),
    // Records the commits each task makes, observed either side of every subtask. The
    // set every promotion check wants and none could reconstruct — see
    // `domain/taskCommits.ts` for the four derivations that fail. Non-fatal inside the
    // service, so a git failure here never reaches the route.
    (task, observation) => taskCommits.observe(task, observation),
    // Answered from git rather than a hosting API: *merged* means the source's commits
    // are on the target, so no token and no webhook — see `PullRequestWaitService`.
    (task, waits) => pullRequestWaits.merged(task, waits),
    // Only so a failed check can say whether the branch has already fixed the check --
    // see `domain/staleChecker.ts`. A git failure yields no paths and therefore no
    // note, which is the same direction every other optional dependency here chooses.
    async (task, signal) => {
      const changed = await statusService.getChangedPaths(
        task.worktreePath,
        task.baseBranch,
        signal,
      );
      return changed.ok ? changed.value : undefined;
    },
    // Where the branch diverged, for a check that names `${mergeBase}` so it can ask
    // what *this branch* changed rather than how it differs from a moving base. A git
    // failure yields no value, which refuses the check rather than running it against
    // the base's tip -- the comparison whose wrong answers this placeholder exists to
    // stop being reported as findings about the work.
    async (task, signal) => {
      const base = await statusService.getMergeBase(
        task.worktreePath,
        task.baseBranch,
        signal,
      );
      return base.ok && base.value.length > 0 ? base.value : undefined;
    },
    // One fetch per advance, so every comparison against a base ref below is answered
    // against what the remote says now rather than whenever this clone last looked.
    async (task, signal) => statusService.fetchRemotes(task.worktreePath, signal),
    // Which suspect paths carry content already committed on another branch. Asked only
    // about files no stage of the task is recorded as writing, so this runs rarely and
    // over a handful of paths -- see `domain/branchContamination.ts` for why the
    // unattributed set is a filter and never a finding on its own.
    async (task, paths, signal) => {
      const found: Contamination[] = [];
      for (const path of paths) {
        const added = await statusService.getAddedLines(
          task.worktreePath,
          task.baseBranch,
          path,
          signal,
        );
        for (const line of distinctiveLines(added)) {
          const commits = await statusService.findForeignCommits(
            task.worktreePath,
            path,
            line,
            3,
            signal,
          );
          // One confirmed line is the answer. Searching the rest would only lengthen
          // the same finding, and each search is a history scan.
          if (commits.length > 0) {
            found.push({ path, commits });
            break;
          }
        }
      }
      return found;
    },
    // How long a check that says its environment is NOT-READY -- a DEV site still
    // deploying the merge -- is asked again before the stage is held rather than failed.
    () => settings().environmentWaitMinutes() * 60_000,
  );

  const liveRequests = new LiveRequestBridge({
    repository: options.repository,
    askUser,
    permissionGate,
    logger,
    ...options.liveRequests,
  });
  const stopLiveRequests = liveRequests.start();

  return {
    agentProcesses,
    sessions,
    permissionGate,
    askUser,
    liveRequests,
    reducedMcpConfigPath,
    stageRunner,
    scanRunner,
    currentHarness,
    worktreeDiscards,
    worktreeClaims,
    runner,
    /** Ends every session this runtime started and releases what is waiting on them. */
    dispose(): void {
      stopLiveRequests();
      sessions.dispose();
      permissionGate.dispose();
      askUser.dispose();
    },
  };
}
