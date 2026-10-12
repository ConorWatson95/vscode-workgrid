import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { GitClient } from "../git/gitClient";
import { GitStatusService } from "../git/gitStatusService";
import { GitWorktreeService } from "../git/gitWorktreeService";
import { Logger, formatLogError } from "../logging/logger";
import { NodeStateFileIo } from "../persistence/nodeStateFileIo";
import { NodeStateFileLock } from "../persistence/nodeStateFileLock";
import { TaskStateStore } from "../persistence/taskStateStore";
import { HarnessControlService } from "../services/harnessControlService";
import { loadHarness } from "../services/reviewRulesService";
import { loadHeadlessSettings } from "../runner/headlessHost";
import { RunLauncher, ScanLauncher, launchNode } from "./runLauncher";
import { HousekeepingTicker } from "./housekeepingTicker";
import { GitMergeService } from "../git/gitMergeService";
import { SuggestionScanFileStore } from "../persistence/suggestionScanFile";
import { SuggestionControlService } from "../services/suggestionControlService";
import { TaskWorkspaceService } from "../services/taskWorkspaceService";
import { WorktreeProvisioner } from "../services/worktreeProvisioner";
import { BoardFeed } from "./boardFeed";
import { HARNESS_DASHBOARD_HTML } from "./harnessDashboardHtml";
import { HarnessMcpServer } from "./harnessMcpServer";

/**
 * Stdio entry for the harness MCP server: `node dist/harnessMcpServer.js --repo <path>`.
 *
 * It opens the repository's task store exactly as the extension does — the state
 * file under the git common dir, the same atomic writes, the same cross-process
 * lock — so it is a second client of one store rather than a store of its own. No
 * legacy Memento is passed: adopting it is the extension's job, and a repository
 * with no state file simply has no runs here yet.
 *
 * **Nothing but JSON-RPC may reach stdout.** A stray line is framed as a protocol
 * message and the host drops the server; every diagnostic goes to stderr.
 */

class StderrLogger implements Logger {
  info(message: string): void {
    process.stderr.write(`[harness-mcp] ${message}\n`);
  }
  warn(message: string): void {
    process.stderr.write(`[harness-mcp] warn: ${message}\n`);
  }
  error(message: string, error?: unknown): void {
    process.stderr.write(
      `[harness-mcp] error: ${message}${error === undefined ? "" : ` ${formatLogError(error)}`}\n`,
    );
  }
  debug(): void {
    // Silent: a host's MCP log is not the place for per-call noise.
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const logger = new StderrLogger();
  const git = new GitClient(logger);
  const statusService = new GitStatusService(git);
  const worktrees = new GitWorktreeService(git, statusService);

  const requested = path.resolve(argument("--repo") ?? process.cwd());
  const root = await worktrees.getRepositoryRoot(requested);
  if (!root.ok) {
    logger.error(`${requested} is not inside a git repository.`);
    process.exit(1);
  }
  const repositoryRoot = root.value;

  const io = new NodeStateFileIo();
  const store = new TaskStateStore({
    io,
    git: worktrees,
    logger,
    createLock: (stateFilePath) => new NodeStateFileLock(stateFilePath, logger),
  });
  const repository = await store.forRepository(repositoryRoot);
  logger.info(`serving ${repositoryRoot} from ${repository.path}`);

  // The extension's own settings, read from VS Code's files, so a custom
  // `harnessConfigPath` is honoured here too and the runner this starts is told nothing
  // different from what the window would have been.
  const host = loadHeadlessSettings(repositoryRoot);
  for (const problem of host.read.problems) logger.warn(`settings not applied: ${problem}`);

  // Read per decision rather than once, so an edit to harness.json reaches the next
  // re-run without restarting the server.
  const service = new HarnessControlService(
    repository,
    repositoryRoot,
    { now: () => new Date().toISOString() },
    () => loadHarness(repositoryRoot, { configuredPath: host.settings.harnessConfigPath() }),
    new RunLauncher({ repository, repositoryRoot, storageDir: host.storageDir }),
  );
  // Suggested work: read from the scan file beside the state file, scanned by a
  // headless runner, and started through the same creation VS Code uses.
  const stateDirectory = path.dirname(repository.path);
  const scanFile = new SuggestionScanFileStore(io, async () => stateDirectory);
  const readScan = () => scanFile.read(repositoryRoot);
  const merges = new GitMergeService(git);
  const suggestions = new SuggestionControlService({
    repositoryRoot,
    repository,
    harness: () => loadHarness(repositoryRoot, { configuredPath: host.settings.harnessConfigPath() }),
    readScan,
    alive,
    scans: new ScanLauncher({ repositoryRoot, storageDir: host.storageDir, readScan }),
    branches: async () => {
      const [listed, current] = await Promise.all([
        merges.listBranches(repositoryRoot),
        worktrees.getCurrentBranch(repositoryRoot),
      ]);
      return {
        list: listed.ok ? listed.value : [],
        ...(current.ok && current.value ? { current: current.value } : {}),
      };
    },
    settings: () => host.settings,
    service: new TaskWorkspaceService(repository, worktrees, statusService, logger),
    provisioner: new WorktreeProvisioner(logger),
    logger,
    now: () => new Date().toISOString(),
  });

  if (process.argv.includes("--watch")) {
    watchBoard(new BoardFeed(service, repositoryRoot, suggestions), stateDirectory, logger);
    // The background repairs VS Code runs on its own timers, run here while the pane
    // is open so a repository driven only from Claude still gets them.
    new HousekeepingTicker(
      () => launchNode(path.join(__dirname, "harnessRunner.js"), ["tick", "--repo", repositoryRoot, "--detach"]),
      logger,
    ).start();
    return;
  }
  const server = new HarnessMcpServer(
    service,
    HARNESS_DASHBOARD_HTML,
    { name: "task-workspaces-harness", version: "0.1.0", repositoryRoot },
    logger,
    () => host.settings.advanceAfterAnswering(),
    suggestions,
  );

  const inFlight = new Set<Promise<void>>();
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    const pending: Promise<void> = server
      .handle(message as Parameters<HarnessMcpServer["handle"]>[0])
      .then((reply) => {
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
      })
      .catch((error: unknown) => logger.error("unhandled", error))
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  });
  // A host that writes its requests and closes stdin at once — a mod's one-shot
  // `$.process.run` does exactly that — lost every reply still being computed to an
  // exit that raced it. Answer what was asked, then go.
  input.on("close", () => {
    void Promise.allSettled([...inFlight]).then(() => process.exit(0));
  });
}

/**
 * `--watch`: push the board as JSON lines for as long as the host holds the process.
 *
 * The *directory* is watched, never the file, because every write is an atomic
 * rename that replaces the file a file watch was holding. Events arrive in bursts
 * (temp file, rename, lock), so they are coalesced, and only one read runs at a
 * time — parsing a 16MB state file takes longer than the gap between bursts. The
 * interval is the backstop for a watcher that misses an event, which `fs.watch`
 * is documented to do; it costs one parse when nothing changed, and sends nothing.
 *
 * It does not end on stdin closing: a mod's `$.process.spawn` with no input closes
 * stdin before the child has started, so that would end the feed at once. The host
 * ends it by killing it when the pane closes; if the host itself dies first, the
 * parent check stops a feed nobody is reading from polling a 16MB file forever.
 */
function watchBoard(feed: BoardFeed, directory: string, logger: Logger): void {
  const parent = process.ppid;
  let running = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        for (const message of await feed.poll()) {
          process.stdout.write(`${JSON.stringify(message)}\n`);
        }
      } while (again);
    } catch (error) {
      logger.error("board read failed", error);
    } finally {
      running = false;
    }
  };
  const soon = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void poll(), WATCH_DEBOUNCE_MS);
  };

  try {
    fs.watch(directory, soon).on("error", (error) => logger.error("watch failed", error));
  } catch (error) {
    logger.error(`cannot watch ${directory}; falling back to the interval alone`, error);
  }
  setInterval(() => void poll(), WATCH_FALLBACK_MS);
  setInterval(() => {
    if (!alive(parent)) process.exit(0);
  }, PARENT_CHECK_MS);
  void poll();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and is not ours to signal, which is still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const WATCH_DEBOUNCE_MS = 200;
const WATCH_FALLBACK_MS = 30_000;
const PARENT_CHECK_MS = 5_000;

main().catch((error: unknown) => {
  process.stderr.write(`[harness-mcp] fatal: ${formatLogError(error)}\n`);
  process.exit(1);
});
