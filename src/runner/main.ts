import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { GitClient } from "../git/gitClient";
import { GitStatusService } from "../git/gitStatusService";
import { GitWorktreeService } from "../git/gitWorktreeService";
import { Logger, formatLogError } from "../logging/logger";
import { NodeStateFileIo } from "../persistence/nodeStateFileIo";
import { NodeStateFileLock } from "../persistence/nodeStateFileLock";
import { taskStateDir } from "../persistence/taskStateFile";
import { TaskStateStore } from "../persistence/taskStateStore";
import { ProtocolSkillInstaller } from "../services/protocolSkillInstaller";
import { ReviewPlanService } from "../services/reviewPlanService";
import { loadHarness, loadReviewRules } from "../services/reviewRulesService";
import { driveRoute } from "../services/routeDriver";
import { RunLeaseService } from "../services/runLeaseService";
import { buildStageRuntime } from "../services/stageRuntime";
import { loadHeadlessSettings, runnerLogPath } from "./headlessHost";

/**
 * Headless entry: `node dist/harnessRunner.js advance --repo <path> --task <id> [--detach]`.
 *
 * Advances one task's route exactly as the extension's Advance Route does — the same
 * runtime (`services/stageRuntime.ts`), the same preparation and lease
 * (`services/routeDriver.ts`) — with no VS Code anywhere. It exits when the route
 * stops: at a gate, a question, a failure, the end, or a stop request.
 *
 * Phase 1 runs with live questions and the permission gate **off**, forced rather than
 * read: nobody is attached to answer either mid-turn. A stage that needs information
 * replies NEEDS-INFO and the route stops on it, which the dashboard can answer; a
 * refused tool call stops the stage as it does with the gate disabled in VS Code.
 *
 * `--detach` re-launches the same command as a detached process with no stdio and
 * exits at once. That intermediate step is load-bearing on Windows: a host that kills
 * its tool call's process tree on a timeout reaches a detached child while its parent
 * is alive, and does not once the parent has exited. Probed both ways.
 */

class FileLogger implements Logger {
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  private write(level: string, message: string): void {
    fs.appendFileSync(this.file, `${new Date().toISOString()} ${level} ${message}\n`);
  }
  info(message: string): void {
    this.write("info ", message);
  }
  warn(message: string): void {
    this.write("warn ", message);
  }
  error(message: string, error?: unknown): void {
    this.write("error", `${message}${error === undefined ? "" : ` ${formatLogError(error)}`}`);
  }
  debug(message: string): void {
    this.write("debug", message);
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`[harness-runner] ${message}\n`);
  process.exit(2);
}

/** Starts this same command again, detached and silent, then leaves it to run. */
function detach(): void {
  const args = process.argv.slice(1).filter((arg) => arg !== "--detach");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`${JSON.stringify({ started: true, pid: child.pid })}\n`);
}

async function main(): Promise<void> {
  if (process.argv[2] !== "advance") {
    fail("usage: harnessRunner advance --repo <path> --task <id> [--detach]");
  }
  const taskId = argument("--task") ?? fail("--task is required.");
  if (process.argv.includes("--detach")) {
    detach();
    return;
  }

  const requested = path.resolve(argument("--repo") ?? process.cwd());
  // Questions and held calls are on whenever VS Code would have them on: the dashboard
  // answers both through the state file (`liveRequestBridge.ts`), so a headless stage
  // waits for a person exactly as one in VS Code does.
  const host = loadHeadlessSettings(requested);
  const logger = new FileLogger(runnerLogPath(host.storageDir, taskId));
  logger.info(`--- headless advance of ${taskId}, pid ${process.pid}`);
  // Which files were read is part of the run's account: a setting VS Code would apply
  // and this did not is the one divergence nothing else would reveal.
  logger.info(`settings from: ${host.read.sources.join(", ") || "(no settings files; defaults)"}`);
  for (const problem of host.read.problems) logger.warn(`settings not applied: ${problem}`);

  const git = new GitClient(logger);
  const statusService = new GitStatusService(git);
  const worktreeService = new GitWorktreeService(git, statusService);
  const root = await worktreeService.getRepositoryRoot(requested);
  if (!root.ok) {
    logger.error(`${requested} is not inside a git repository.`);
    process.exit(1);
  }
  const repositoryRoot = root.value;
  const settings = () => host.settings;

  const store = new TaskStateStore({
    io: new NodeStateFileIo(),
    git: worktreeService,
    logger,
    createLock: (stateFilePath) => new NodeStateFileLock(stateFilePath, logger),
  });
  const repository = await store.forRepository(repositoryRoot);
  const stateDirectory = path.dirname(repository.path);

  const commonDir = await worktreeService.getGitCommonDir(repositoryRoot);
  const protocolPluginDir = commonDir.ok
    ? new ProtocolSkillInstaller(logger).install(taskStateDir(commonDir.value))?.pluginDir
    : undefined;

  // No confirmation: there is nobody to ask, and the reviews are applied as they were
  // before the extension started asking.
  const reviewPlans = new ReviewPlanService(statusService, repository, logger, (rootPath) =>
    loadReviewRules(rootPath, { configuredPath: settings().harnessConfigPath() }),
  );

  const runtime = buildStageRuntime({
    logger,
    settings,
    storageDir: host.storageDir,
    repositoryRoot: () => repositoryRoot,
    configRoot: () => repositoryRoot,
    protocolPluginDir: () => protocolPluginDir,
    repository,
    reviewPlans,
    gitClient: git,
    statusService,
    worktreeService,
    // Only this run's own task: an answer delivered into another task's brief may be
    // followed by an advance, and starting other tasks is not this process's to do.
    liveRequests: { servesBrief: (id) => id === taskId },
  });
  // How answers and decisions written by another client reach this run's stage.
  const stopServing = watchDirectory(
    stateDirectory,
    () => void runtime.liveRequests.serve(repositoryRoot),
    logger,
  );

  // Asked twice is told to go: the first lets the current step settle and the lease
  // be released, the second is somebody who has stopped waiting for that.
  let signalled = false;
  const onSignal = (): void => {
    if (signalled) {
      runtime.dispose();
      process.exit(130);
    }
    signalled = true;
    logger.info("signal received; stopping at the current step.");
    runtime.runner.cancel(taskId);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const leases = new RunLeaseService(repository, "headless");
  let exitCode = 0;
  try {
    const driven = await driveRoute(
      {
        repository,
        runner: runtime.runner,
        leases,
        definitions: () => loadHarness(repositoryRoot, { configuredPath: settings().harnessConfigPath() }),
        logger,
        now: () => new Date().toISOString(),
        watchState: (onChange) => watchDirectory(stateDirectory, onChange, logger),
        logPath: runnerLogPath(host.storageDir, taskId),
      },
      taskId,
    );
    if (driven.kind === "refused") {
      logger.warn(`not advanced: ${driven.message}`);
      exitCode = 3;
    } else {
      logger.info(`stopped: ${JSON.stringify(driven.report.outcome)}`);
      for (const denial of driven.report.denials) {
        logger.warn(`refused: ${denial.tool} — ${denial.command ?? denial.reason}`);
      }
    }
  } catch (error) {
    logger.error("the advance failed", error);
    exitCode = 1;
  } finally {
    stopServing();
    runtime.dispose();
  }
  logger.info(`--- exit ${exitCode}`);
  process.exit(exitCode);
}

/**
 * Calls back on changes in the state directory, coalesced.
 *
 * The directory, never the file: every write is an atomic rename that replaces the
 * file a file watch was holding.
 */
function watchDirectory(directory: string, onChange: () => void, logger: Logger): () => void {
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = fs.watch(directory, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    });
    watcher.on("error", (error) => logger.warn(`state watch failed: ${String(error)}`));
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch (error) {
    // Without it a stop request does not reach this run; the run still ends at the
    // next gate, so this is a degraded stop and not a runaway.
    logger.warn(`cannot watch ${directory}, so a stop request will not reach this run: ${String(error)}`);
    return () => undefined;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[harness-runner] fatal: ${formatLogError(error)}\n`);
  process.exit(1);
});
