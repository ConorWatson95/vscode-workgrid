import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderReportPage } from "../ui/reportHtml";
import { Result, err, ok } from "../utilities/result";

/** Opens a report somewhere a person can read all of it. */
export interface ReportOpener {
  open(report: { name: string; title: string; markdown: string }): Promise<Result<string, string>>;
}

/**
 * Writes a report as a page under the extension's storage directory and hands it to
 * whatever the machine opens `.html` with.
 *
 * One file per task or stage, overwritten on each open, so the directory holds the
 * latest copy of each rather than growing by one per click. Outside the repository
 * for the reason the state file is: anything written into a worktree is a change git
 * would report as the task's work.
 */
export class FileReportOpener implements ReportOpener {
  constructor(
    private readonly directory: string,
    private readonly launch: (file: string) => void = openWithDefaultApp,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(report: { name: string; title: string; markdown: string }): Promise<Result<string, string>> {
    const file = path.join(this.directory, `${fileName(report.name)}.html`);
    try {
      await fs.promises.mkdir(this.directory, { recursive: true });
      const stamp = this.now().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
      await fs.promises.writeFile(file, renderReportPage(report.title, report.markdown, stamp), "utf8");
      this.launch(file);
      return ok(file);
    } catch (error) {
      return err(`Could not open the report: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function fileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "report";
}

/**
 * The platform's own "open this file" verb, detached so the browser outlives this
 * process. `explorer.exe` rather than `cmd /c start`, which re-parses its arguments
 * and splits a path at the space a Windows profile name routinely has.
 */
export function openWithDefaultApp(file: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["explorer.exe", [file]]
      : process.platform === "darwin"
        ? ["open", [file]]
        : ["xdg-open", [file]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  // A launcher that is missing must not take the server down with it; the file is
  // written either way, and its path is in the tool's reply.
  child.on("error", () => undefined);
  child.unref();
}
