import * as vscode from "vscode";
import { TaskWorkspace, TaskWorkspaceLiveState } from "../domain/taskWorkspace";
import {
  taskStatusPresentation,
  buildContextValue,
  AgentActivity,
} from "./statusPresentation";
import { deriveTaskPhase, taskPhasePresentation } from "./taskPhase";
import { ChecklistItem, DenialItem, TaskStage } from "../domain/taskPipeline";
import {
  checklistPresentation,
  pipelineSummary,
  stagePresentation,
} from "./stagePresentation";

/** A tree node representing a single task workspace. */
export class TaskWorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly live: TaskWorkspaceLiveState | undefined,
    readonly agentActivity: AgentActivity | undefined,
  ) {
    // A harnessed task expands to show its route; an unharnessed one has no
    // children, so it stays a leaf exactly as before.
    super(
      task.name,
      (task.pipeline?.stages.length ?? 0) > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = task.id;

    let iconId: string;
    let colorId: string | undefined;
    let statusLabel: string;

    // Terminal task states (archived/failed/creating) win; otherwise the icon
    // reflects the derived lifecycle phase (git state + agent activity).
    if (task.status === "archived" || task.status === "failed" || task.status === "creating") {
      const p = taskStatusPresentation(task.status);
      iconId = p.iconId;
      statusLabel = p.label;
    } else {
      const phase = deriveTaskPhase({
        activity: agentActivity,
        dirty: live?.isDirty ?? false,
        commitsAhead: live?.commitsAhead ?? 0,
      });
      const p = taskPhasePresentation(phase);
      iconId = p.iconId;
      colorId = p.colorId;
      statusLabel = p.label;
    }

    this.iconPath = new vscode.ThemeIcon(
      iconId,
      colorId ? new vscode.ThemeColor(colorId) : undefined,
    );
    const harnessed = (task.pipeline?.stages.length ?? 0) > 0;
    const questions = task.pipeline?.pendingQuestion?.items.length ?? 0;
    this.contextValue = buildContextValue(
      task.status,
      task.agent?.status,
      harnessed,
      questions > 0,
    );

    const descriptionParts = [statusLabel];
    // Lead with the block: a route waiting on an answer is doing nothing, and
    // that is invisible otherwise.
    if (questions > 0) {
      descriptionParts.unshift(
        questions === 1 ? "1 question" : `${questions} questions`,
      );
    }
    if (live?.isDirty) {
      descriptionParts.push(`${live.changedFileCount} changed`);
    } else if ((live?.commitsAhead ?? 0) > 0) {
      descriptionParts.push(`${live!.commitsAhead} commit${live!.commitsAhead === 1 ? "" : "s"}`);
    }
    this.description = descriptionParts.join(" · ");

    // The pipeline records its own route label, so a project route that has since
    // been renamed or removed still renders correctly.
    const summary = pipelineSummary(task.pipeline, task.pipeline?.routeLabel);

    this.tooltip = new vscode.MarkdownString(
      [
        `**${task.name}**`,
        "",
        `Status: ${statusLabel}`,
        summary ? `Route: ${summary}` : "",
        // Shown because it is handed to every stage prompt — if it is wrong or
        // empty, every agent session inherits that.
        task.description ? `\nBrief: ${task.description}` : "",
        `Branch: \`${task.branchName}\``,
        `Base: \`${task.baseBranch}\``,
        `Worktree: \`${task.worktreePath}\``,
        live && !live.worktreeExists ? "\n⚠️ Worktree missing" : "",
        live?.isDirty ? `\nChanged files: ${live.changedFileCount}` : "",
        task.agent ? `\nAgent: ${task.agent.provider} (${task.agent.status})` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    // Default click opens the task detail view.
    this.command = {
      command: "taskWorkspaces.detail",
      title: "Open Task Details",
      arguments: [this],
    };
  }
}

/**
 * A pipeline stage nested under its task. Read-only progress: stages are driven
 * by the engine, not edited here.
 */
export class StageTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly stage: TaskStage,
  ) {
    const outstanding = (stage.checklist ?? []).filter((i) => !i.checked);
    // Only expand when there is something underneath worth seeing.
    super(
      stage.name,
      (stage.checklist ?? []).length > 0
        ? outstanding.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    const visual = stagePresentation(stage);
    this.id = `${task.id}/${stage.id}`;
    this.iconPath = new vscode.ThemeIcon(
      visual.iconId,
      visual.colorId ? new vscode.ThemeColor(visual.colorId) : undefined,
    );
    this.description = visual.description;
    this.contextValue = visual.contextValue;

    this.tooltip = new vscode.MarkdownString(
      [
        `**${stage.name}** — ${visual.label}`,
        "",
        stage.intent,
        stage.addedByRule ? `\n_Added by a review rule: ${stage.addedByRule}_` : "",
        stage.subtasks.length > 0
          ? `\nSubtasks:\n${stage.subtasks
              .map((s) => `- ${s.title} (${s.status})`)
              .join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/** One verification item, nested under the stage that raised it. */
export class ChecklistTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly stageId: string,
    readonly item: ChecklistItem,
  ) {
    super(item.text, vscode.TreeItemCollapsibleState.None);
    const visual = checklistPresentation(item);
    this.id = `${task.id}/${stageId}/${item.id}`;
    this.iconPath = new vscode.ThemeIcon(
      visual.iconId,
      visual.colorId ? new vscode.ThemeColor(visual.colorId) : undefined,
    );
    this.contextValue = visual.contextValue;
    this.description = item.checked ? "verified" : "";
    this.tooltip = new vscode.MarkdownString(
      [
        item.text,
        "",
        item.checked ? `Verified${item.checkedAt ? ` at ${item.checkedAt}` : ""}.` : "Not yet verified.",
        item.note ? `\nNote: ${item.note}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/**
 * A tool call the permission layer refused, with an approve action on the row.
 *
 * A row rather than a panel or a toast: a toast is transient and stacks across
 * tasks, and this needs one button, not a window. It sits under the stage that
 * hit it and stays until granted, so it is still there after a reload.
 */
export class DenialTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly denial: DenialItem,
  ) {
    super(denial.command ?? denial.tool, vscode.TreeItemCollapsibleState.None);
    this.id = `${task.id}/denial/${denial.id}`;
    this.iconPath = new vscode.ThemeIcon(
      denial.granted ? "pass" : "shield",
      new vscode.ThemeColor(
        denial.granted ? "testing.iconPassed" : "notificationsWarningIcon.foreground",
      ),
    );
    // Only an ungranted refusal offers the approve action.
    this.contextValue = denial.granted ? "denialGranted" : "denialPending";
    this.description = denial.granted
      ? "allowed"
      : `${denial.tool} denied${denial.attempts > 1 ? ` · ${denial.attempts} attempts` : ""}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${denial.tool} was denied**`,
        "",
        denial.command ? "```\n" + denial.command + "\n```" : "",
        denial.reason,
        "",
        denial.rule
          ? denial.granted
            ? `Rule added: \`${denial.rule}\``
            : `Approving adds \`${denial.rule}\` to \`.claude/settings.local.json\`.`
          : "No rule could be derived from this call; grant it by hand.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/** A node representing an untracked git worktree that can be adopted. */
export class OrphanWorktreeTreeItem extends vscode.TreeItem {
  constructor(
    readonly worktreePath: string,
    readonly branch: string | undefined,
  ) {
    super(branch ?? worktreePath, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("git-branch");
    this.description = "untracked";
    this.contextValue = "orphan";
    this.tooltip = new vscode.MarkdownString(
      [
        "**Untracked worktree**",
        "",
        branch ? `Branch: \`${branch}\`` : "(detached)",
        `Path: \`${worktreePath}\``,
        "",
        "Adopt it to track it as a task, or remove it without tracking it.",
      ].join("\n"),
    );
    this.command = {
      command: "taskWorkspaces.adopt",
      title: "Adopt Worktree",
      arguments: [this],
    };
  }
}

/** A simple message node (e.g. "no repository", "no tasks yet"). */
export class MessageTreeItem extends vscode.TreeItem {
  constructor(message: string, iconId = "info") {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = "message";
  }
}
