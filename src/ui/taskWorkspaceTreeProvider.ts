import * as vscode from "vscode";
import { TaskWorkspaceService } from "../services/taskWorkspaceService";
import {
  TaskWorkspaceTreeItem,
  MessageTreeItem,
  OrphanWorktreeTreeItem,
  StageTreeItem,
  ChecklistTreeItem,
  DenialTreeItem,
  QuestionTreeItem,
  HeldCallTreeItem,
  TaskGroupTreeItem,
} from "./taskWorkspaceTreeItem";
import { groupForTask, groupStartsExpanded, groupTasks } from "./taskGrouping";
import { Logger } from "../logging/logger";
import { AgentActivity } from "./statusPresentation";
import { PendingGate } from "../services/permissionGateService";

type TreeNode =
  | TaskGroupTreeItem
  | TaskWorkspaceTreeItem
  | OrphanWorktreeTreeItem
  | MessageTreeItem
  | StageTreeItem
  | ChecklistTreeItem
  | DenialTreeItem
  | QuestionTreeItem
  | HeldCallTreeItem;

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
    /**
     * Tool calls the agent is blocked on right now. Live rather than persisted:
     * a held call only exists while a CLI process is waiting on it, so it must
     * come from the gate and not from the task record.
     */
    private readonly getHeldCalls: (taskId: string) => PendingGate[] = () => [],
    /** The rule "Always allow" would add for a held call, when one exists. */
    private readonly ruleForHeldCall: (held: PendingGate) => string | undefined = () =>
      undefined,
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
    // A group holds its children already; nothing is re-derived on expansion.
    if (element instanceof TaskGroupTreeItem) return element.children;

    // A harnessed task expands into its route's stages; a stage expands into the
    // verification items it raised. Everything else is a leaf.
    if (element instanceof TaskWorkspaceTreeItem) {
      // Held calls lead, and sit under the task rather than a stage: the agent is
      // stopped dead on them, and burying one inside a collapsed stage is how the
      // last version of this made rows the user could not reach.
      const held = this.getHeldCalls(element.task.id).map(
        (call) =>
          new HeldCallTreeItem(element.task, call, this.ruleForHeldCall(call)),
      );
      const stages = (element.task.pipeline?.stages ?? []).map(
        (stage) => new StageTreeItem(element.task, stage),
      );
      return [...held, ...stages];
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
      // Questions lead: a route waiting on an answer is doing nothing at all,
      // whereas a refusal may only have cost the stage one tool.
      const pending = element.task.pipeline?.pendingQuestion;
      const asked =
        pending?.stageId === element.stage.id
          ? pending.items.map((item) => new QuestionTreeItem(element.task, item))
          : [];
      return [...asked, ...refused, ...checklist];
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

    const taskItems: TaskWorkspaceTreeItem[] = [];
    for (const { task } of reconciled) {
      const live = await this.service.getLiveState(task);
      taskItems.push(
        new TaskWorkspaceTreeItem(
          task,
          live,
          this.getAgentActivity(task),
          this.getHeldCalls(task.id).length,
        ),
      );
    }

    // Grouped by what each task needs, because a task can sit at a verification
    // gate for days: a flat list makes finding the one that moved a matter of
    // reading every row. Collapses back to a plain list when everything lands in
    // one group, so a small repository is not made to look like a filing system.
    const groups = groupTasks(taskItems, (item) =>
      groupForTask({
        status: item.task.status,
        pipeline: item.task.pipeline,
        heldCalls: this.getHeldCalls(item.task.id).length,
      }),
    );

    const nodes: TreeNode[] =
      groups.length <= 1
        ? taskItems
        : groups.map(
            (group) =>
              new TaskGroupTreeItem(
                group.id,
                group.label,
                group.items,
                groupStartsExpanded(group.id),
              ),
          );

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
