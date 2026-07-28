import * as vscode from "vscode";
import { TaskWorkspace, TaskWorkspaceLiveState } from "../domain/taskWorkspace";
import {
  taskStatusPresentation,
  buildContextValue,
  AgentActivity,
} from "./statusPresentation";
import { deriveTaskPhase, taskPhasePresentation } from "./taskPhase";

/** A tree node representing a single task workspace. */
export class TaskWorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly live: TaskWorkspaceLiveState | undefined,
    readonly agentActivity: AgentActivity | undefined,
  ) {
    super(task.name, vscode.TreeItemCollapsibleState.None);
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
    this.contextValue = buildContextValue(task.status, task.agent?.status);

    const descriptionParts = [statusLabel];
    if (live?.isDirty) {
      descriptionParts.push(`${live.changedFileCount} changed`);
    } else if ((live?.commitsAhead ?? 0) > 0) {
      descriptionParts.push(`${live!.commitsAhead} commit${live!.commitsAhead === 1 ? "" : "s"}`);
    }
    this.description = descriptionParts.join(" · ");

    this.tooltip = new vscode.MarkdownString(
      [
        `**${task.name}**`,
        "",
        `Status: ${statusLabel}`,
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
