import { ControlOutcome, ControlRefusal } from "../domain/harnessControl";
import { orderBaseBranchChoices } from "../domain/baseBranchChoices";
import { SuggestionSource, orderLookup } from "../domain/suggestionSourceFile";
import { RouteDefinition } from "../domain/taskRoute";
import {
  rankSuggestions,
  startedSuggestionKeys,
  suggestionKey,
  withoutStarted,
} from "../domain/taskSuggestion";
import { CopyEntry } from "../domain/worktreeCopyPlan";
import { SiblingLinkEntry } from "../domain/siblingLinkPlan";
import { StoredScan, scanStillRunning } from "../persistence/suggestionScanFile";
import { TaskRepository } from "../persistence/taskRepository";
import { Result, err, ok } from "../utilities/result";
import { scanFailures, scannedSuggestions } from "./suggestionScanService";
import { TaskCreationDeps, createTaskWithRoute, describeCreateError } from "./taskCreation";
import { TaskWorkspaceService } from "./taskWorkspaceService";

/**
 * Suggested work for a client that is not the extension: the list, a scan, and
 * starting a task from one item.
 *
 * Holds nothing between calls, for `HarnessControlService`'s reason. The list is read
 * from the scan file and the task store each time, so what Claude shows is what VS
 * Code shows, and a task started in either drops the item from both.
 *
 * It runs no scan itself. A scan is minutes of session and a dashboard call has
 * seconds, so `startScan` hands it to a headless runner and returns once that runner
 * has said it is scanning.
 */

export interface SuggestionView {
  sourceId: string;
  sourceLabel: string;
  ref: string;
  title: string;
  rank?: string;
  state?: string;
  url?: string;
  detail?: string;
  /** Below the source's rank floor, or in a state it hides. Shown on request. */
  hidden: boolean;
}

export interface SuggestionBoard {
  /** False when the project declares no source; the list is then absent, not empty. */
  configured: boolean;
  sources: { id: string; label: string }[];
  scannedAt?: string;
  /** Set while a scan is running in some process. */
  scanningSince?: string;
  /** One line per source that failed, so an empty list is not read as a quiet board. */
  failures: string[];
  /** Ranked, with work already under way removed. */
  suggestions: SuggestionView[];
}

export interface TaskOptions {
  routes: { id: string; label: string; description: string; stageCount: number }[];
  usingBuiltInRoutes: boolean;
  branchPrefixes: string[];
  /** First is the default. */
  baseBranches: string[];
}

export interface StartTaskRequest {
  sourceId: string;
  ref: string;
  name: string;
  branchPrefix: string;
  baseBranch: string;
  /** Absent makes a chat task: a worktree and nothing else. */
  routeId?: string;
  assessFirst?: boolean;
  /** Handed to every stage. Defaults to the ticket's reference, link and detail. */
  brief?: string;
}

export interface ScanControl {
  /** Resolves once a runner has started the scan, or with why it did not. */
  start(): Promise<{ ok: boolean; message: string }>;
}

export interface SuggestionControlDeps {
  repositoryRoot: string;
  repository: Pick<TaskRepository, "getByRepository" | "save">;
  harness: () => {
    routes: RouteDefinition[];
    usingBuiltInRoutes: boolean;
    suggestionSources: SuggestionSource[];
  };
  readScan: () => Promise<StoredScan>;
  alive: (pid: number) => boolean;
  /** Absent means this client cannot start scans, and says so when asked to. */
  scans?: ScanControl;
  branches: () => Promise<{ list: string[]; current?: string }>;
  settings: () => {
    branchPrefixes(): string[];
    defaultBaseBranch(): string;
    worktreeParentDir(): string;
    copyIntoWorktree(): CopyEntry[];
    linkSiblings(): SiblingLinkEntry[];
  };
  service: Pick<TaskWorkspaceService, "createTask">;
  provisioner: TaskCreationDeps["provisioner"];
  logger: TaskCreationDeps["logger"];
  now(): string;
}

export class SuggestionControlService {
  constructor(private readonly deps: SuggestionControlDeps) {}

  async board(): Promise<SuggestionBoard> {
    const sources = this.deps.harness().suggestionSources;
    const stored = await this.readScan();
    const running = scanStillRunning(stored, this.deps.alive);
    const base = {
      configured: sources.length > 0,
      sources: sources.map((source) => ({ id: source.id, label: source.label })),
      ...(stored.scan ? { scannedAt: stored.scan.scannedAt } : {}),
      ...(running ? { scanningSince: running.startedAt } : {}),
      failures: scanFailures(stored.scan),
    };
    if (sources.length === 0) return { ...base, suggestions: [] };

    const labels = new Map((stored.scan?.outcomes ?? []).map((o) => [o.sourceId, o.sourceLabel]));
    // Archived tasks do not count as started, as in the VS Code tree: an abandoned task's
    // ticket is very likely still open, so it is offered again.
    const started = startedSuggestionKeys(
      (await this.deps.repository.getByRepository(this.deps.repositoryRoot)).filter(
        (task) => task.status !== "archived",
      ),
    );
    const ranked = withoutStarted(
      rankSuggestions(scannedSuggestions(stored.scan), orderLookup(sources)),
      started,
    );
    return {
      ...base,
      suggestions: ranked.map((entry) => ({
        sourceId: entry.sourceId,
        sourceLabel: labels.get(entry.sourceId) ?? entry.sourceId,
        ref: entry.ref,
        title: entry.title,
        ...(entry.rank ? { rank: entry.rank } : {}),
        ...(entry.state ? { state: entry.state } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
        hidden: entry.hidden,
      })),
    };
  }

  async startScan(): Promise<Result<{ message: string }, ControlRefusal>> {
    if (this.deps.harness().suggestionSources.length === 0) {
      return err({
        kind: "refused",
        message:
          'No suggestion sources are configured. Add a "suggestions" array to ' +
          ".taskworkspaces/harness.json.",
      });
    }
    const running = scanStillRunning(await this.readScan(), this.deps.alive);
    if (running) {
      return ok({ message: `A scan is already running (since ${running.startedAt}).` });
    }
    if (!this.deps.scans) return err({ kind: "refused", message: "This client cannot start scans." });
    const started = await this.deps.scans.start();
    return started.ok ? ok({ message: started.message }) : err({ kind: "refused", message: started.message });
  }

  async options(): Promise<TaskOptions> {
    const harness = this.deps.harness();
    const settings = this.deps.settings();
    const branches: { list: string[]; current?: string } = await this.deps
      .branches()
      .catch(() => ({ list: [] }));
    // The same default VS Code's picker offers: configured, else the main checkout's branch.
    const defaultBase = settings.defaultBaseBranch().trim() || branches.current || "HEAD";
    return {
      routes: harness.routes.map((route) => ({
        id: route.id,
        label: route.label,
        description: route.description,
        stageCount: route.stages.length,
      })),
      usingBuiltInRoutes: harness.usingBuiltInRoutes,
      branchPrefixes: settings.branchPrefixes(),
      baseBranches: orderBaseBranchChoices(branches.list, defaultBase),
    };
  }

  /**
   * Starts a task from one suggestion, with the answers VS Code's create flow asks for.
   *
   * The item must be in the current scan: its link is taken from there, and an item
   * that has gone from the list is one the source no longer offers. A ticket some task
   * already carries is refused, because two tasks for one ticket is the confusion the
   * origin link exists to prevent.
   */
  async startTask(
    request: StartTaskRequest,
  ): Promise<Result<ControlOutcome, ControlRefusal>> {
    const name = request.name.trim();
    if (!name) return err({ kind: "refused", message: "A task needs a name." });
    if (!request.branchPrefix.trim() || !request.baseBranch.trim()) {
      return err({ kind: "refused", message: "A task needs a branch type and a base branch." });
    }

    const stored = await this.readScan();
    const wanted = suggestionKey(request);
    const suggestion = scannedSuggestions(stored.scan).find((item) => suggestionKey(item) === wanted);
    if (!suggestion) {
      return err({ kind: "refused", message: `${request.ref} is not in the last scan. Scan again.` });
    }
    const tasks = await this.deps.repository.getByRepository(this.deps.repositoryRoot);
    const existing = tasks.find(
      (task) => task.status !== "archived" && task.origin && suggestionKey(task.origin) === wanted,
    );
    if (existing) {
      return err({ kind: "refused", message: `"${existing.name}" is already the task for ${request.ref}.` });
    }

    const harness = this.deps.harness();
    let route: RouteDefinition | undefined;
    if (request.routeId) {
      route = harness.routes.find((candidate) => candidate.id === request.routeId);
      if (!route) return err({ kind: "refused", message: `No route "${request.routeId}" in this project.` });
    }

    const settings = this.deps.settings();
    const brief =
      request.brief?.trim() ||
      [suggestion.ref, suggestion.url, suggestion.detail]
        .filter((part): part is string => !!part && part.trim().length > 0)
        .join(" — ");
    const created = await createTaskWithRoute(
      {
        service: this.deps.service,
        provisioner: this.deps.provisioner,
        repository: this.deps.repository,
        logger: this.deps.logger,
        now: () => this.deps.now(),
      },
      {
        repositoryRoot: this.deps.repositoryRoot,
        name,
        branchPrefix: request.branchPrefix.trim(),
        baseBranch: request.baseBranch.trim(),
        description: brief,
        configuredParentDir: settings.worktreeParentDir(),
        origin: {
          sourceId: suggestion.sourceId,
          ref: suggestion.ref,
          ...(suggestion.url ? { url: suggestion.url } : {}),
          at: this.deps.now(),
        },
        ...(route ? { route, assessFirst: request.assessFirst === true } : {}),
        copyIntoWorktree: settings.copyIntoWorktree(),
        linkSiblings: settings.linkSiblings(),
      },
    );
    if (!created.ok) return err({ kind: "refused", message: describeCreateError(created.error) });

    const { task, provisionProblems, routeFailed } = created.value;
    const notes = [
      provisionProblems > 0 ? `${provisionProblems} file(s) could not be copied into the worktree.` : "",
      routeFailed ? "Its route could not be saved, so it is a chat task for now." : "",
    ].filter(Boolean);
    return ok({
      task,
      changed: true,
      message:
        `Created "${task.name}" on ${task.branchName}` +
        (route && !routeFailed ? ` with the ${route.label} route` : "") +
        "." +
        (notes.length ? ` ${notes.join(" ")}` : ""),
    });
  }

  private async readScan(): Promise<StoredScan> {
    try {
      return await this.deps.readScan();
    } catch {
      return {};
    }
  }
}
