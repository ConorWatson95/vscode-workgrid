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
  const worktrees = new GitWorktreeService(git, new GitStatusService(git));

  const requested = path.resolve(argument("--repo") ?? process.cwd());
  const root = await worktrees.getRepositoryRoot(requested);
  if (!root.ok) {
    logger.error(`${requested} is not inside a git repository.`);
    process.exit(1);
  }
  const repositoryRoot = root.value;

  const store = new TaskStateStore({
    io: new NodeStateFileIo(),
    git: worktrees,
    logger,
    createLock: (stateFilePath) => new NodeStateFileLock(stateFilePath, logger),
  });
  const repository = await store.forRepository(repositoryRoot);
  logger.info(`serving ${repositoryRoot} from ${repository.path}`);

  const service = new HarnessControlService(repository, repositoryRoot, {
    now: () => new Date().toISOString(),
  });
  const server = new HarnessMcpServer(
    service,
    HARNESS_DASHBOARD_HTML,
    { name: "task-workspaces-harness", version: "0.1.0", repositoryRoot },
    logger,
  );

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
    void server
      .handle(message as Parameters<HarnessMcpServer["handle"]>[0])
      .then((reply) => {
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
      })
      .catch((error: unknown) => logger.error("unhandled", error));
  });
  input.on("close", () => process.exit(0));
}

main().catch((error: unknown) => {
  process.stderr.write(`[harness-mcp] fatal: ${formatLogError(error)}\n`);
  process.exit(1);
});
