import * as vscode from "vscode";
import { TaskWorkspaceService } from "../services/taskWorkspaceService";
import {
  TaskWorkspaceTreeItem,
  MessageTreeItem,
  OrphanWorktreeTreeItem,
  StageTreeItem,
  ChecklistTreeItem,
  DenialTreeItem,
} from "./taskWorkspaceTreeItem";
import { Logger } from "../logging/logger";
import { AgentActivity } from "./statusPresentation";

type TreeNode =
  | TaskWorkspaceTreeItem
  | OrphanWorktreeTreeItem
  | MessageTreeItem
  | StageTreeItem
  | ChecklistTreeItem
  | DenialTreeItem;

/**
 * Tree data provider for the Task Workspaces view. Resolves the active
 * repository, reconciles tasks against git, and renders one node per task with
 * live status/dirty information.
 */
export class TaskWorkspaceTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private showArchived = false;

  constructor(
    private readonly service: TaskWorkspaceService,
    private readonly resolveRepositoryRoot: () => string | undefined,
    private readonly logger: Logger,
    private readonly getAgentActivity: (
      task: import("../domain/taskWorkspace").TaskWorkspace,
    ) => AgentActivity | undefined,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  /** Toggles whether archived tasks are shown; returns the new state. */
  toggleArchived(): boolean {
    this.showArchived = !this.showArchived;
    this.emitter.fire();
    return this.showArchived;
  }

  isShowingArchived(): boolean {
    return this.showArchived;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    // A harnessed task expands into its route's stages; a stage expands into the
    // verification items it raised. Everything else is a leaf.
    if (element instanceof TaskWorkspaceTreeItem) {
      return (element.task.pipeline?.stages ?? []).map(
        (stage) => new StageTreeItem(element.task, stage),
      );
    }
    if (element instanceof StageTreeItem) {
      const checklist = (element.stage.checklist ?? []).map(
        (item) => new ChecklistTreeItem(element.task, element.stage.id, item),
      );
      // Refusals belong to the stage that hit them, and lead: the stage cannot
      // do its job until they are granted or deliberately ignored.
      const denials = element.task.pipeline?.pendingDenials;
      const refused =
        denials?.stageId === element.stage.id
          ? denials.items.map((item) => new DenialTreeItem(element.task, item))
          : [];
      return [...refused, ...checklist];
    }
    if (element) return [];

    const repositoryRoot = this.resolveRepositoryRoot();
    if (!repositoryRoot) {
      return [
        new MessageTreeItem("Open a Git repository to manage task workspaces.", "repo"),
      ];
    }

    const result = await this.service.listTasks(repositoryRoot);
    if (!result.ok) {
      this.logger.error("Failed to list tasks", result.error);
      return [new MessageTreeItem("Failed to read git worktrees.", "error")];
    }

    const reconciled = result.value.tasks.filter(
      (t) => this.showArchived || t.task.status !== "archived",
    );

    if (reconciled.length === 0 && result.value.orphans.length === 0) {
      const msg = this.showArchived
        ? "No task workspaces."
        : "No task workspaces yet. Create one to begin.";
      return [new MessageTreeItem(msg, "add")];
    }

    const nodes: TreeNode[] = [];
    for (const { task } of reconciled) {
      const live = await this.service.getLiveState(task);
      nodes.push(
        new TaskWorkspaceTreeItem(task, live, this.getAgentActivity(task)),
      );
    }

    for (const orphan of result.value.orphans) {
      nodes.push(
        new OrphanWorktreeTreeItem(orphan.worktree.path, orphan.worktree.branch),
      );
    }

    return nodes;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
