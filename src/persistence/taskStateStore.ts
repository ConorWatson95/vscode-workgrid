import { TaskWorkspace } from "../domain/taskWorkspace";
import { Result } from "../utilities/result";
import { FileTaskRepository, StateFileIo, StateLogSink } from "./fileTaskRepository";
import { planLegacyAdoption } from "./legacyStateAdoption";
import { StateFileLock } from "./nodeStateFileLock";
import { TaskRepository, normalizeRoot } from "./taskRepository";
import { taskStateFilePath } from "./taskStateFile";

/**
 * Resolves the right task store for a repository, and routes calls to it.
 *
 * Two problems are solved here, both consequences of state becoming per-
 * repository instead of one global blob:
 *
 * 1. The store cannot be built at startup, because it depends on a git
 *    directory that is only known once the active repository is resolved — and
 *    that can change while the extension runs.
 * 2. The hand-off from the old global Memento has to happen exactly once per
 *    repository, lazily, the first time that repository is seen.
 *
 * Kept free of `vscode`: the git dependency is a one-method interface and the
 * legacy store is just a `TaskRepository`, so a headless caller constructs this
 * the same way the extension does.
 */

/** The one thing this needs from git. `GitWorktreeService` satisfies it. */
export interface GitCommonDirSource {
  getGitCommonDir(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<Result<string, unknown>>;
}

export interface TaskStateStoreOptions {
  io: StateFileIo;
  git: GitCommonDirSource;
  /**
   * The old global store. Read once per repository to adopt its tasks, then
   * never written — it stays intact as a backup.
   */
  legacy?: TaskRepository;
  logger?: StateLogSink;
  /**
   * Builds the cross-process lock for a repository's state file.
   *
   * A factory rather than an instance, because the lock is per file and the
   * store holds many repositories. Optional: without one the repositories rely
   * on their in-process queue alone, which is what every test wants and what a
   * single-process caller already had.
   */
  createLock?: (stateFilePath: string) => StateFileLock;
}

export class TaskStateStore {
  /** One repository per normalised root; adoption runs once per entry. */
  private readonly stores = new Map<string, Promise<FileTaskRepository>>();

  constructor(private readonly options: TaskStateStoreOptions) {}

  /**
   * The file-backed store for a repository, adopting legacy tasks if this is
   * the first time we have seen it. Rejects if the git directory cannot be
   * resolved — the caller decides whether to fall back.
   */
  async forRepository(repositoryRoot: string): Promise<FileTaskRepository> {
    const key = normalizeRoot(repositoryRoot);
    const existing = this.stores.get(key);
    if (existing) return existing;

    // Cache the promise, not the result, so concurrent callers during startup
    // share one adoption rather than racing to seed the same file.
    const pending = this.open(repositoryRoot);
    this.stores.set(key, pending);
    // A failed resolution must not be cached, or a transient git error would
    // stick for the rest of the session.
    pending.catch(() => this.stores.delete(key));
    return pending;
  }

  private async open(repositoryRoot: string): Promise<FileTaskRepository> {
    const gitDir = await this.options.git.getGitCommonDir(repositoryRoot);
    if (!gitDir.ok) {
      throw new Error(`Could not resolve the git directory for ${repositoryRoot}.`);
    }

    const repository = new FileTaskRepository(
      gitDir.value,
      this.options.io,
      this.options.logger,
      undefined,
      this.options.createLock?.(taskStateFilePath(gitDir.value)),
    );
    await this.adopt(repository, repositoryRoot);
    return repository;
  }

  private async adopt(
    repository: FileTaskRepository,
    repositoryRoot: string,
  ): Promise<void> {
    const legacy = this.options.legacy;
    if (!legacy) return;

    const stateFileExists = await repository.exists();
    if (stateFileExists) return;

    let legacyTasks: TaskWorkspace[];
    try {
      legacyTasks = await legacy.getAll();
    } catch (error) {
      // An unreadable legacy store must not stop the new one from working.
      this.options.logger?.info(
        `Task state: could not read extension state to adopt tasks: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    const plan = planLegacyAdoption({ stateFileExists, legacyTasks, repositoryRoot });
    if (!plan) return;

    if (await repository.seed(plan.seed)) {
      this.options.logger?.info(`Task state: ${plan.note}`);
    }
  }
}

/**
 * A `TaskRepository` that resolves its real store on every call.
 *
 * Lets the service graph be built at activation, before any repository is
 * known, and keeps working when the active repository changes. Falls back when
 * the resolver yields nothing — a window with no git repository still needs a
 * store that answers rather than throws.
 */
export class RoutedTaskRepository implements TaskRepository {
  constructor(
    private readonly resolve: () => Promise<TaskRepository | undefined>,
    private readonly fallback: TaskRepository,
  ) {}

  private async target(): Promise<TaskRepository> {
    return (await this.resolve()) ?? this.fallback;
  }

  async getAll(): Promise<TaskWorkspace[]> {
    return (await this.target()).getAll();
  }

  async getByRepository(repositoryRoot: string): Promise<TaskWorkspace[]> {
    return (await this.target()).getByRepository(repositoryRoot);
  }

  async get(id: string): Promise<TaskWorkspace | undefined> {
    return (await this.target()).get(id);
  }

  async save(task: TaskWorkspace): Promise<void> {
    return (await this.target()).save(task);
  }

  async delete(id: string): Promise<void> {
    return (await this.target()).delete(id);
  }
}
