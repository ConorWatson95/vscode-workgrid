import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";

import { Logger } from "../logging/logger";
import {
  decideSessionProcesses,
  ProbedProcess,
  SessionProcessRecord,
  summariseSessionProcesses,
} from "../domain/sessionProcesses";

/**
 * Durable record of the agent processes this machine started, and the activation
 * sweep that reaps the ones an unclean shutdown left behind.
 *
 * See `domain/sessionProcesses.ts` for the decision rules and for why a sweep must
 * only ever consider processes the harness itself recorded.
 *
 * ## Why not the state file
 *
 * A pid is an ephemeral, machine-local fact. `state.json` lives under the git common
 * dir and is shared by every worktree of the repository and by every window open on
 * it, and it is the durable record of the work — a task's own history. Writing pids
 * into it would put a second machine's process ids in front of this one's sweep, and
 * would churn the file the tree renders from on every session. This lives beside the
 * permission gate root under `globalStorageUri` instead, which is already the home
 * for machine-local harness state.
 *
 * ## Write-through, not cached
 *
 * The file is read and rewritten on every change rather than held in memory, for the
 * same reason `nodeStateFileIo` does it: the point of the record is to survive a
 * process that did not get to flush anything. A cached registry would be lost in
 * exactly the crash it exists to cover.
 */
export interface SessionProcessRegistryOptions {
  /** Directory to keep the registry in; created on demand. */
  directory: string;
  logger: Logger;
  /** Injected so tests need no real processes. */
  probe?: (pids: readonly number[]) => Promise<ProbedProcess[]>;
  kill?: (pid: number) => void;
  now?: () => string;
}

const FILE = "agent-processes.json";

export class SessionProcessRegistry {
  private readonly file: string;

  constructor(private readonly options: SessionProcessRegistryOptions) {
    this.file = path.join(options.directory, FILE);
  }

  /** Records a spawned session. Never throws: losing a record must not fail a stage. */
  async record(entry: Omit<SessionProcessRecord, "startedAt">): Promise<void> {
    try {
      const at = this.options.now?.() ?? new Date().toISOString();
      const records = await this.read();
      // Replace any record for the same pid: a recycled pid we spawned ourselves is
      // the current one, and two records for one pid would decide it twice.
      const next = records.filter((record) => record.pid !== entry.pid);
      next.push({ ...entry, startedAt: at });
      await this.write(next);
    } catch (error) {
      this.options.logger.warn(`Harness could not record agent process ${entry.pid}: ${error}`);
    }
  }

  /** Drops a record once its process has been stopped cleanly. */
  async forget(pid: number): Promise<void> {
    try {
      const records = await this.read();
      const next = records.filter((record) => record.pid !== pid);
      if (next.length !== records.length) await this.write(next);
    } catch (error) {
      this.options.logger.warn(`Harness could not clear agent process ${pid}: ${error}`);
    }
  }

  /**
   * Reaps processes left by an unclean shutdown.
   *
   * `activeSubtaskIds` is every subtask the pipelines currently consider running.
   * Anything else a record names has outlived its work.
   *
   * Non-fatal throughout: a sweep that cannot read the registry, probe the OS or kill
   * a process leaves things exactly as they were. This runs at activation, and
   * failing activation over a tidy-up would trade a leaked process for a broken
   * extension.
   */
  async sweep(activeSubtaskIds: ReadonlySet<string>): Promise<void> {
    try {
      const records = await this.read();
      if (records.length === 0) return;

      const probe = this.options.probe ?? probeProcesses;
      const probes = await probe(records.map((record) => record.pid));
      const decisions = decideSessionProcesses(records, probes, activeSubtaskIds);

      for (const decision of decisions.filter((d) => d.action === "kill")) {
        try {
          (this.options.kill ?? killProcess)(decision.record.pid);
          this.options.logger.warn(
            `Harness killed agent process ${decision.record.pid} ` +
              `(task ${decision.record.taskId}): ${decision.reason}`,
          );
        } catch (error) {
          this.options.logger.warn(
            `Harness could not kill agent process ${decision.record.pid}: ${error}`,
          );
        }
      }

      // Killed and forgotten records both leave; kept ones stay for the next sweep.
      const kept = decisions
        .filter((decision) => decision.action === "keep")
        .map((decision) => decision.record);
      await this.write(kept);

      const summary = summariseSessionProcesses(decisions);
      if (summary) this.options.logger.info(`Harness ${summary}.`);
    } catch (error) {
      this.options.logger.warn(`Harness could not sweep agent processes: ${error}`);
    }
  }

  private async read(): Promise<SessionProcessRecord[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is SessionProcessRecord =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as SessionProcessRecord).pid === "number" &&
          typeof (entry as SessionProcessRecord).taskId === "string",
      );
    } catch {
      // Absent or unreadable both mean "nothing recorded", which is the safe reading:
      // a sweep with no records kills nothing.
      return [];
    }
  }

  private async write(records: readonly SessionProcessRecord[]): Promise<void> {
    await fs.mkdir(this.options.directory, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(records, null, 2), "utf8");
  }
}

/** Liveness only, and portable. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which is emphatically not
    // ours to kill — reported as alive so the decision layer keeps it.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Asks the OS when each pid started, so a recycled pid can be told from ours.
 *
 * Windows only for now, via a single CIM query rather than one per pid. Everywhere
 * else the start time comes back undefined, which the decision layer treats as "do
 * not kill" — the honest degradation, and the reason it is expressed as an absent
 * measurement rather than a default.
 */
async function probeProcesses(pids: readonly number[]): Promise<ProbedProcess[]> {
    const liveness = pids.map((pid) => ({ pid, alive: alive(pid) }));
  if (process.platform !== "win32") return liveness;

  const wanted = liveness.filter((entry) => entry.alive).map((entry) => entry.pid);
  if (wanted.length === 0) return liveness;

  const starts = await windowsStartTimes(wanted);
  return liveness.map((entry) => ({
    ...entry,
    ...(starts.has(entry.pid) ? { osStartedAt: starts.get(entry.pid) } : {}),
  }));
}

function windowsStartTimes(pids: readonly number[]): Promise<Map<number, string>> {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    "ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CreationDate.ToUniversalTime().ToString('o') }";

  return new Promise((resolve) => {
    const found = new Map<number, string>();
    let out = "";
    // -NonInteractive so it can never wait on a prompt during activation.
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
    );
    const done = () => {
      for (const line of out.split(/\r?\n/)) {
        const [pid, at] = line.trim().split(/\s+/);
        const parsed = Number(pid);
        if (Number.isFinite(parsed) && at) found.set(parsed, at);
      }
      resolve(found);
    };
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve(found));
    child.on("close", done);
    // A probe that hangs must not hold up activation. Resolving with what we have
    // means unidentified pids, which the decision layer keeps rather than kills.
    setTimeout(() => {
      child.kill();
      resolve(found);
    }, 5_000).unref?.();
  });
}

function killProcess(pid: number): void {
  if (process.platform === "win32") {
    // The CLI spawns tool and subagent processes of its own, and `process.kill` on
    // Windows terminates only the named process — so a stage that had delegated would
    // leave its children behind. /T takes the tree.
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  process.kill(pid, "SIGTERM");
}
