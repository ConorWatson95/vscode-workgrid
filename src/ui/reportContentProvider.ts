import * as vscode from "vscode";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { formatStageReport, formatTaskReport, withLiveActivity } from "./stageReport";
import { LiveActivity } from "../services/pipelineRunner";
import {
  compareRuns,
  describeArms,
  formatRunComparison,
} from "../domain/runComparison";
import {
  decodeReportTarget,
  encodeReportTarget,
  reportFileName,
} from "./reportUriParts";

export const REPORT_SCHEME = "taskworkspaces-report";

/** What a task's currently running subtask has done so far, if any is running. */
export type LiveActivitySource = (taskId: string) => LiveActivity | undefined;

/**
 * Serves stage and task reports as read-only virtual documents, re-rendered from
 * the repository each time they are read.
 *
 * Replaces an untitled document holding a formatted snapshot. That had two
 * faults, both of which showed up the moment a report was opened on a stage that
 * was still running: it was editable, so closing it asked whether to save
 * something the user never wrote; and it was frozen at the moment it was opened,
 * so a stage that went on to run commands and write files kept showing the empty
 * report it had when it started.
 *
 * Rendering on read fixes the second only together with `refresh()` — a document
 * nobody tells VS Code has changed is never re-read.
 */
export class ReportContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  /** Every report handed out, so a refresh can invalidate all of them. */
  private readonly issued = new Map<string, vscode.Uri>();

  private liveActivity?: LiveActivitySource;
  private timer?: ReturnType<typeof setInterval>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly loadTask: (taskId: string) => Promise<TaskWorkspace | undefined>) {}

  /**
   * Re-reads open reports on a timer, so one left open follows a running stage.
   *
   * A timer rather than an event because the thing worth watching — an agent's
   * tool calls — has no signal the editor hears. Firing when nothing changed is
   * free: VS Code compares the content and raises no document change, so the
   * preview does not so much as flicker.
   */
  startAutoRefresh(intervalMs = 2000): void {
    if (this.timer) return;

    // Unconditional. This used to skip a tick unless `workspace.textDocuments`
    // still held a report — which stopped updates dead once a tab was switched
    // away from: a virtual document with no *visible editor* can be closed by VS
    // Code while the markdown preview built from it stays open, so the guard went
    // false while the thing it was protecting was still on screen. Firing for a
    // URI nobody holds is cheap; not firing for one somebody does is the bug.
    this.timer = setInterval(() => this.refresh(), intervalMs);

    // Refreshed on the way back too, rather than waiting out a tick. A preview
    // that was hidden while the content changed can render its stale copy on
    // becoming visible again, and one stale frame is what "it stopped updating"
    // looks like.
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.refresh();
      }),
    );
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = decodeReportTarget(uri.query);
    if (!target) return "_This report is no longer addressable._";

    const task = await this.loadTask(target.taskId);
    if (!task) return "_This task no longer exists._";

    if (target.compareWith) {
      const other = await this.loadTask(target.compareWith);
      if (!other) return "_The task this was being compared against no longer exists._";
      if (!task.pipeline || !other.pipeline) {
        // A task with no route has no stages and no usage, so a comparison would be
        // a table of dashes that reads as "this run cost nothing".
        return "_A comparison needs both tasks to have a route._";
      }
      const comparison = compareRuns(
        { label: task.name, pipeline: task.pipeline },
        { label: other.name, pipeline: other.pipeline },
      );
      const arms = describeArms(task.pipeline, other.pipeline);
      return formatRunComparison(comparison) + (arms ? `\n\n---\n\n${arms}\n` : "\n");
    }

    if (!target.stageId) return formatTaskReport(task.name, task.pipeline);

    const stage = task.pipeline?.stages.find((s) => s.id === target.stageId);
    if (!stage) {
      // Reverting a stage or reloading a route can remove one, and the report may
      // still be open. Said plainly rather than rendered empty.
      return `# ${target.stageId}\n\n_This stage is no longer part of the task's route._`;
    }

    // A running subtask's work is not on the persisted task yet, so it is overlaid
    // here — without it, watching a stage work shows nothing until it stops.
    const live = this.liveActivity?.(task.id);
    return formatStageReport(
      task.name,
      withLiveActivity(stage, live?.stageId === stage.id ? live : undefined),
      task.pipeline,
    );
  }

  /**
   * Where in-progress activity comes from. Set after construction because the
   * runner that holds it is built later than the providers.
   */
  setLiveActivitySource(source: LiveActivitySource): void {
    this.liveActivity = source;
  }

  /** A stable URI for one task's or one stage's report. */
  uriFor(
    task: { id: string; name: string },
    stage?: { id: string; name: string },
  ): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: REPORT_SCHEME,
      path: `/${reportFileName(task.name, stage?.name)}`,
      query: encodeReportTarget({ taskId: task.id, stageId: stage?.id }),
    });
    this.issued.set(uri.toString(), uri);
    return uri;
  }

  /** A stable URI for a two-run comparison. */
  comparisonUriFor(
    a: { id: string; name: string },
    b: { id: string; name: string },
  ): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: REPORT_SCHEME,
      path: `/${reportFileName(`${a.name} vs ${b.name}`)}`,
      query: encodeReportTarget({ taskId: a.id, compareWith: b.id }),
    });
    this.issued.set(uri.toString(), uri);
    return uri;
  }

  /**
   * Tells VS Code every open report may have changed. Driven from the same signal
   * that refreshes the tree, so a report follows a running stage rather than
   * needing to be closed and reopened.
   */
  refresh(): void {
    for (const uri of this.issued.values()) this.emitter.fire(uri);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.emitter.dispose();
  }
}
