import { spawn } from "node:child_process";
import {
  CommandOutcome,
  VerificationCommandRunner,
  prepareOutput,
} from "./verificationRunner";

/**
 * Runs a verification command through the platform shell.
 *
 * A shell rather than an argv array, because these commands are written by hand in a
 * project's harness config and read like commands — `dotnet build -warnaserror`,
 * `npm test`, a `sqlcmd` line with a query. Requiring them to be split into
 * arguments would make the config worse at the one job it has.
 *
 * That means a project's config can execute. It is no more trust than the file
 * already has — it drives every agent prompt — but it is a different *kind*, so it
 * is loaded from the repository root like the rest of the harness config and never
 * from a worktree: a branch must not be able to choose the command that certifies
 * it.
 */
export class NodeVerificationRunner implements VerificationCommandRunner {
  constructor(
    /** Bounded so a hung check cannot park a route indefinitely. */
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  run(command: string, cwd: string, signal?: AbortSignal): Promise<CommandOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: CommandOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        signal,
      });

      let captured = "";
      const collect = (chunk: Buffer | string) => {
        // Both streams into one buffer, in arrival order: a build interleaves them,
        // and separating them makes the output harder to read than the console was.
        captured += chunk.toString();
        // Bounded here as well as at the end, so a runaway command cannot exhaust
        // memory before the timeout fires.
        if (captured.length > 200_000) captured = captured.slice(-200_000);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);

      const timer = setTimeout(() => {
        child.kill();
        finish({
          exitCode: -1,
          output: prepareOutput(captured),
          spawnError: `timed out after ${Math.round(this.timeoutMs / 60_000)} minute(s)`,
        });
      }, this.timeoutMs);

      child.on("error", (error) => {
        finish({ exitCode: -1, output: prepareOutput(captured), spawnError: error.message });
      });

      child.on("close", (code) => {
        // A killed process reports a null code. Treated as a failure, since it did
        // not get to say otherwise.
        finish({ exitCode: code ?? -1, output: prepareOutput(captured) });
      });
    });
  }
}
