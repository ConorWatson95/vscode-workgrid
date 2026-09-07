/**
 * Terminating an agent process, and why the obvious way does not.
 *
 * `claudeStreamSession` spawns the CLI with `{ shell: true }` on Windows, because the
 * CLI is resolved through the shell's own PATH/PATHEXT rules. The consequence had
 * never been followed through: **the direct child is a `cmd.exe` shim, not the CLI**,
 * so `child.pid` names the shim and `child.kill()` terminates the shim and leaves the
 * CLI running. Probed 7 Sep 2026, mirroring the real spawn:
 *
 * | what | pid |
 * |---|---|
 * | `spawn(cmd, args, { shell: true })` returns | the `cmd.exe` shim |
 * | the process actually doing the work | its child |
 * | after `child.kill()` | **child still alive** |
 *
 * Which made three paths orphan a live stage session rather than end it — `stop()`,
 * `dispose()` on a clean deactivate, and `checkpointRestart` — and the module note in
 * `domain/sessionProcesses.ts` said the opposite in as many words. Measured on the
 * development machine the same morning: four live `claude -p` stage sessions against
 * **two** subtasks the state file considered active, and two orphaned MCP servers whose
 * parents were long gone, the older of them 12.6 days old.
 *
 * The registry's own reaping had the same hole from the other end. It records
 * `child.pid` — the shim — so once a `stop()` had killed the shim, the record was
 * *forgotten* as "process is no longer running" while the CLI it was standing for
 * lived on. A sweep that reports success over a surviving orphan is the failure the
 * unquoted hook command already taught this codebase: a check that silently does not
 * fire is indistinguishable from the feature being absent.
 *
 * ## The invariant that makes the shim pid sound
 *
 * `cmd /c` waits for its child, so the shim's lifetime brackets the CLI's exactly.
 * Recording the shim is therefore fine — **provided every kill is a tree kill**, since
 * `/T` walks the live tree and a shim killed first takes the tree out of reach. That
 * is the whole reason this is one shared helper rather than a fix at one call site.
 *
 * Pure command construction, plus a thin executor over it. Vscode-free.
 */

import { spawn } from "child_process";

/** The command that takes a process and its descendants, where one is needed. */
export interface KillTreeCommand {
  command: string;
  args: string[];
}

/**
 * How to kill `pid` and everything below it, or `undefined` where a signal will do.
 *
 * Undefined means the caller should signal the process directly: on POSIX the direct
 * child *is* the CLI, so there is no shim to see past. That leaves the CLI's own tool
 * and subagent children behind, which is the pre-existing behaviour and a separate
 * question from this one.
 */
export function killTreeCommand(pid: number, platform: string): KillTreeCommand | undefined {
  if (platform !== "win32") return undefined;
  // The CLI spawns tool and subagent processes of its own and sits under a shell shim
  // of ours, so the tree is the only unit that corresponds to "this session".
  return { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] };
}

/**
 * Terminates `pid` and its descendants.
 *
 * Throws only on the POSIX path, where `process.kill` reports an already-dead process
 * — kept rather than swallowed so `SessionProcessRegistry` can announce a kill it
 * could not perform, which is the rule that part of the runtime follows.
 */
export function killProcessTree(pid: number, platform: string = process.platform): void {
  const tree = killTreeCommand(pid, platform);
  if (tree) {
    spawn(tree.command, tree.args, { windowsHide: true });
    return;
  }
  process.kill(pid, "SIGTERM");
}
