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
  SuggestionGroupTreeItem,
  SuggestionTreeItem,
} from "./taskWorkspaceTreeItem";
import { groupForTask, groupStartsExpanded, groupTasks } from "./taskGrouping";
import { Logger } from "../logging/logger";
import { AgentActivity } from "./statusPresentation";
import { PendingGate } from "../services/permissionGateService";
import {
  rankSuggestions,
  startedSuggestionKeys,
  visibleSuggestions,
  withoutStarted,
} from "../domain/taskSuggestion";
import { orderLookup, SuggestionSource } from "../domain/suggestionSourceFile";
import {
  ScanResult,
  scanFailures,
  scannedSuggestions,
} from "../services/suggestionScanService";
import { suggestionGroupDescription } from "./suggestionRow";

type TreeNode =
  | TaskGroupTreeItem
  | TaskWorkspaceTreeItem
  | OrphanWorktreeTreeItem
  | MessageTreeItem
  | StageTreeItem
  | ChecklistTreeItem
  | DenialTreeItem
  | QuestionTreeItem
  | HeldCallTreeItem
  | SuggestionGroupTreeItem
  | SuggestionTreeItem;

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
  /**
   * Whether filtered-out suggestions are shown.
   *
   * A view flag rather than anything persisted, which is what makes "hide but findable"
   * true: nothing was ever recorded as dismissed, so what this reveals is always the
   * complete set the sources still report.
   */
  private showHiddenSuggestions = false;

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
    /**
     * The project's suggestion sources, read fresh so a config edit takes effect
     * without a reload. Empty means the project declared none, and the group is absent
     * entirely — the feature is invisible rather than empty, because an empty
     * "Suggestions" heading on every repository is a permanent advert for something
     * that project has not opted into.
     */
    private readonly getSuggestionSources: (
      repositoryRoot: string,
    ) => SuggestionSource[] = () => [],
    /** The last scan for a repository, or undefined when none has been run. */
    private readonly getLastScan: (repositoryRoot: string) => ScanResult | undefined = () =>
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

  /** Toggles whether filtered-out suggestions are shown; returns the new state. */
  toggleHiddenSuggestions(): boolean {
    this.showHiddenSuggestions = !this.showHiddenSuggestions;
    this.emitter.fire();
    return this.showHiddenSuggestions;
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
    if (element instanceof SuggestionGroupTreeItem) return element.children;
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

    // Built here so the empty case below can carry it too. A repository with no tasks
    // is precisely when suggested work matters most, and returning early without it
    // hid the group on exactly the morning it was useful.
    const suggestions = this.suggestionNodes(
      repositoryRoot,
      result.value.tasks.map((entry) => entry.task),
    );

    if (reconciled.length === 0 && result.value.orphans.length === 0) {
      const msg = this.showArchived
        ? "No task workspaces."
        : "No task workspaces yet. Create one to begin.";
      return [new MessageTreeItem(msg, "add"), ...suggestions];
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

    // Last, and collapsed. Suggestions are work that has not started, so they must not
    // compete with a task that is stopped and waiting.
    nodes.push(...suggestions);

    return nodes;
  }

  /**
   * The suggestions group, or nothing at all.
   *
   * Absent rather than empty when a project declares no sources: a permanent
   * "Suggestions" heading on a repository that never opted in is an advert, not
   * information.
   *
   * Started work is dropped by matching a task's `origin`, and **archived tasks do not
   * count as started**. An archived task is one abandoned or cleared away, and its
   * ticket is very likely still open — so the honest thing is to offer it again. Work
   * that genuinely finished is filtered by the source's own `hideStates` instead, which
   * is the source of truth for whether it is done.
   */
  private suggestionNodes(
    repositoryRoot: string,
    tasks: readonly import("../domain/taskWorkspace").TaskWorkspace[],
  ): SuggestionGroupTreeItem[] {
    const sources = this.getSuggestionSources(repositoryRoot);
    if (sources.length === 0) return [];

    const scan = this.getLastScan(repositoryRoot);
    const started = startedSuggestionKeys(
      tasks.filter((task) => task.status !== "archived"),
    );
    const ranked = withoutStarted(
      rankSuggestions(scannedSuggestions(scan), orderLookup(sources)),
      started,
    );
    const shown = visibleSuggestions(ranked, this.showHiddenSuggestions);

    const children: (SuggestionTreeItem | MessageTreeItem)[] = shown.map(
      (suggestion) => new SuggestionTreeItem(suggestion),
    );
    if (children.length === 0) {
      // Worded on what actually happened, because "nothing to suggest" covers three
      // different situations and only one of them means there is no work.
      const hiddenCount = ranked.length - shown.length;
      children.push(
        new MessageTreeItem(
          !scan
            ? "Run \"Scan for Work\" to see what your sources are holding."
            : hiddenCount > 0
              ? `Nothing above the rank filter. ${hiddenCount} hidden — show them to look.`
              : "Nothing outstanding in your sources.",
          "search",
        ),
      );
    }

    return [
      new SuggestionGroupTreeItem(
        children,
        suggestionGroupDescription(
          shown.length,
          scan?.scannedAt,
          Date.now(),
          scanFailures(scan).length,
        ),
      ),
    ];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
