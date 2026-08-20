import * as vscode from "vscode";
import { TaskWorkspaceService } from "../services/taskWorkspaceService";
import { TaskWorkspace, TaskWorkspaceLiveState } from "../domain/taskWorkspace";
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
import { createRenderThrottle } from "../utilities/renderThrottle";

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
 * The shortest gap between two renders of the tree.
 *
 * Chosen against the measured cost of one: ~400ms of git for nine tasks, dominated by a
 * `git status --porcelain` that takes 250–280ms per worktree on a large solution. Set
 * below that and a busy route can still queue renders faster than they complete, which is
 * the saturation this exists to stop; set it much above and a row that has genuinely
 * changed sits stale long enough to be noticed.
 */
const MIN_RENDER_INTERVAL_MS = 400;

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
  private readonly throttle = createRenderThrottle(() => this.emitter.fire(), {
    minIntervalMs: MIN_RENDER_INTERVAL_MS,
  });
  /**
   * The root render in flight, shared by every caller until the next `refresh()`.
   *
   * VS Code asks for the root more than once per redraw — a reveal, a selection, the
   * detail view following along — and each ask used to start its own 18 git spawns.
   * Cleared by `refresh()`, so it can never serve a row from before a change.
   */
  private rootRender?: Promise<TreeNode[]>;

  /**
   * Live git state per task id, kept only so the *first* render of a window need
   * not wait for git.
   *
   * `getLiveState` is two git processes per task — 18 concurrent spawns and
   * ~400ms on nine tasks — and nothing appears until every one of them returns.
   * That cost lands on activation and on every window reload, which is exactly
   * when someone is waiting to see whether anything moved. Twice in one morning
   * it was the slowest part of recovering a stuck task (20 Aug 2026).
   *
   * Deliberately **not** a cache that outlives a render. Populated at the end of
   * a full render and read only when it is empty, so it changes the cold start
   * and nothing else: a refresh still reads git afresh, which is the invariant
   * `refresh` depends on — a command that has just changed something must never
   * be shown a row computed before its change. There is no such prior row on a
   * cold start, which is what makes filling in afterwards honest there and
   * nowhere else.
   */
  private lastLiveStates = new Map<string, TaskWorkspaceLiveState>();

  /** Set while the cold render's git calls are in flight, so only one is started. */
  private fillingIn = false;
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

  /**
   * Asks for a redraw, at most once per {@link MIN_RENDER_INTERVAL_MS}.
   *
   * Throttled because a render is expensive and this is called from around forty places
   * plus every session status change: `getLiveState` is two git processes per task, so one
   * render of nine tasks is 18 concurrent spawns and ~400ms. Uncoalesced, a burst during a
   * running route became overlapping git storms that saturated the extension host — which
   * is why the symptom was never confined to the tree, and why 110ms of git in the
   * base-branch picker took "ages".
   *
   * The memo is dropped first, so the render that does happen reads git afresh. That
   * ordering is the whole correctness argument: a command that has just changed something
   * calls this, and must not be shown a row computed before its change.
   */
  refresh(): void {
    this.rootRender = undefined;
    this.throttle.request();
  }

  /**
   * Redraws now, for a deliberate user action.
   *
   * The Refresh command means "go and look again", and making it wait out an interval is
   * how a button comes to feel broken.
   */
  refreshNow(): void {
    this.rootRender = undefined;
    this.throttle.flush();
  }

  /** Toggles whether archived tasks are shown; returns the new state. */
  toggleArchived(): boolean {
    this.showArchived = !this.showArchived;
    this.refreshNow();
    return this.showArchived;
  }

  /** Toggles whether filtered-out suggestions are shown; returns the new state. */
  toggleHiddenSuggestions(): boolean {
    this.showHiddenSuggestions = !this.showHiddenSuggestions;
    this.refreshNow();
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

    // Single-flight per redraw: concurrent asks for the root share one set of git calls.
    this.rootRender ??= this.computeRoot();
    return this.rootRender;
  }

  /**
   * Reads the live git state the cold render skipped, then asks for a redraw.
   *
   * Errors are swallowed on purpose: this is a second pass over rows that are
   * already on screen and usable, so a git failure here should leave them as they
   * are rather than replace a working tree with an error row. The next deliberate
   * refresh reports it.
   *
   * Guarded by `fillingIn` because VS Code asks for the root more than once per
   * redraw, and each ask would otherwise start its own storm — the same reason
   * `rootRender` is single-flighted.
   */
  private fillIn(tasks: readonly TaskWorkspace[]): void {
    if (this.fillingIn) return;
    this.fillingIn = true;
    void (async () => {
      try {
        await Promise.all(
          tasks.map(async (task) => {
            this.lastLiveStates.set(task.id, await this.service.getLiveState(task));
          }),
        );
      } catch {
        // Left to the next refresh; see above.
      } finally {
        this.fillingIn = false;
      }
      // Only if something was actually read, or a repository whose every call
      // failed would redraw on a loop.
      if (this.lastLiveStates.size > 0) {
        this.rootRender = undefined;
        this.throttle.request();
      }
    })();
  }

  /** Everything under the root: reconciliation, one row per task, orphans, suggestions. */
  private async computeRoot(): Promise<TreeNode[]> {
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

    // The first render of a window draws rows with no live state and fills it in
    // after, because the alternative is an empty panel for the length of a git
    // storm. Everything a row needs to be *found* — its name, status, group, and
    // whether a gate wants you — comes from the state file, which parses in
    // single-digit milliseconds; what git adds is the changed-file counts.
    //
    // Every later render awaits git as before. See `lastLiveStates` for why the
    // distinction is not an optimisation that could be applied to both.
    const cold = this.lastLiveStates.size === 0;
    const taskItems = cold
      ? reconciled.map(
          ({ task }) =>
            new TaskWorkspaceTreeItem(
              task,
              undefined,
              this.getAgentActivity(task),
              this.getHeldCalls(task.id).length,
            ),
        )
      : // Concurrent, because `getLiveState` is two git processes per task and this loop
        // used to await both before starting the next one. On a repository with a dozen
        // tasks that is two dozen serial spawns before a single row appears, which is most
        // of what "the tree takes an age" was. Order is preserved by `Promise.all`, so the
        // grouping below is unaffected.
        await Promise.all(
          reconciled.map(async ({ task }) => {
            const live = await this.service.getLiveState(task);
            this.lastLiveStates.set(task.id, live);
            return new TaskWorkspaceTreeItem(
              task,
              live,
              this.getAgentActivity(task),
              this.getHeldCalls(task.id).length,
            );
          }),
        );

    if (cold) this.fillIn(reconciled.map((entry) => entry.task));

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
    // Before the emitter: a pending render firing into a disposed emitter throws on the
    // way out of the window.
    this.throttle.dispose();
    this.emitter.dispose();
  }
}
