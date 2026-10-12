import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TaskRepository } from "../persistence/taskRepository";
import { RunControl } from "../services/harnessControlService";
import { runnerLogPath } from "../runner/headlessHost";
import { SCAN_TASK_ID } from "../agents/suggestionScanSessionRunner";
import { StoredScan } from "../persistence/suggestionScanFile";
import { ScanControl } from "../services/suggestionControlService";

/**
 * Starts a headless run of a task and waits until it has the task, or has said why not.
 *
 * Returning on the spawn alone would report success for a runner that then refused —
 * VS Code holding the lease, a route with nothing to do — and the operator would watch
 * a run that never started. The lease appearing is the runner's own statement that it
 * is advancing, so that is what is waited for; the log is read for a refusal.
 */
export interface RunLauncherDeps {
  repository: TaskRepository;
  repositoryRoot: string;
  storageDir: string;
  /** `dist/harnessRunner.js`, which ships beside this server. */
  runnerScript?: string;
  /** Runs the launcher step and resolves once it has exited. */
  launch?: (script: string, args: string[]) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

export class RunLauncher implements RunControl {
  constructor(private readonly deps: RunLauncherDeps) {}

  async start(taskId: string): Promise<{ ok: boolean; message: string }> {
    const { repository, repositoryRoot, storageDir } = this.deps;
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const logFile = runnerLogPath(storageDir, taskId);
    const logFrom = sizeOf(logFile);
    const launchedAt = new Date(now()).toISOString();

    try {
      await (this.deps.launch ?? launchNode)(this.deps.runnerScript ?? path.join(__dirname, "harnessRunner.js"), [
        "advance",
        "--repo",
        repositoryRoot,
        "--task",
        taskId,
        "--detach",
      ]);
    } catch (error) {
      return { ok: false, message: `Could not start the runner: ${String(error)}` };
    }

    const deadline = now() + (this.deps.timeoutMs ?? 15_000);
    while (now() < deadline) {
      const lease = (await repository.get(taskId))?.pipeline?.runLease;
      if (lease?.by === "headless" && lease.acquiredAt >= launchedAt) {
        return { ok: true, message: `Advancing in a headless runner (pid ${lease.pid}).` };
      }
      const written = readFrom(logFile, logFrom);
      const refused = /not advanced: (.*)/.exec(written);
      if (refused) return { ok: false, message: refused[1] };
      // A route with one short step left can take the task, run it and give the lease
      // back between two polls, so a finished run is a started one.
      const stopped = /stopped: (.*)/.exec(written);
      if (stopped) return { ok: true, message: `The runner advanced the route and stopped: ${stopped[1]}` };
      if (/--- exit/.test(written)) {
        return { ok: false, message: `The runner exited before taking the task:\n${tail(written)}` };
      }
      await sleep(250);
    }
    const written = readFrom(logFile, logFrom);
    return {
      ok: false,
      message:
        "The runner has not taken the task yet, so it may still be starting." +
        (written ? `\n${tail(written)}` : ` Nothing has been written to ${logFile}.`),
    };
  }
}

/**
 * Starts a suggestion scan in a headless runner and waits until it has begun.
 *
 * The scan file's `scanning` marker is the runner's own statement that it is
 * scanning, written before the first session, so that is what is waited for — the
 * same reasoning as waiting for the lease above.
 */
export interface ScanLauncherDeps {
  repositoryRoot: string;
  storageDir: string;
  readScan: () => Promise<StoredScan>;
  runnerScript?: string;
  launch?: (script: string, args: string[]) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

export class ScanLauncher implements ScanControl {
  constructor(private readonly deps: ScanLauncherDeps) {}

  async start(): Promise<{ ok: boolean; message: string }> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const logFile = runnerLogPath(this.deps.storageDir, SCAN_TASK_ID);
    const logFrom = sizeOf(logFile);
    const launchedAt = new Date(now()).toISOString();

    try {
      await (this.deps.launch ?? launchNode)(this.deps.runnerScript ?? path.join(__dirname, "harnessRunner.js"), [
        "scan",
        "--repo",
        this.deps.repositoryRoot,
        "--detach",
      ]);
    } catch (error) {
      return { ok: false, message: `Could not start the scan: ${String(error)}` };
    }

    const deadline = now() + (this.deps.timeoutMs ?? 15_000);
    while (now() < deadline) {
      const stored = await this.deps.readScan().catch((): StoredScan => ({}));
      if (stored.scanning && stored.scanning.startedAt >= launchedAt) {
        return { ok: true, message: "Scanning. The list updates when it finishes, usually within a few minutes." };
      }
      const written = readFrom(logFile, logFrom);
      const refused = /not scanned: (.*)/.exec(written);
      if (refused) return { ok: false, message: refused[1] };
      if (/--- exit/.test(written)) {
        return { ok: false, message: `The scan ended before it began:\n${tail(written)}` };
      }
      await sleep(250);
    }
    return { ok: false, message: `The scan has not started yet, so it may still be starting. See ${logFile}.` };
  }
}

export function launchNode(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { windowsHide: true, timeout: 10_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readFrom(file: string, offset: number): string {
  try {
    return fs.readFileSync(file).subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}

function tail(text: string, lines = 12): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}
