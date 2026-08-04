import { TaskWorkspace } from "../domain/taskWorkspace";
import { TaskRepository, normalizeRoot } from "./taskRepository";
import {
  decodeTaskStateFile,
  encodeQuarantine,
  encodeTaskStateFile,
  taskStateFilePath,
  taskStateQuarantinePath,
} from "./taskStateFile";

/**
 * Byte-level access to the state file, injected so the repository's rules are
 * testable without a filesystem.
 */
export interface StateFileIo {
  /** Resolves `undefined` when the file does not exist. */
  read(filePath: string): Promise<string | undefined>;
  /**
   * Writes the file, creating parent directories. Must be atomic — a reader
   * must never observe a partial file, because a truncated read looks exactly
   * like a corrupt store.
   */
  write(filePath: string, contents: string): Promise<void>;
}

/** Narrow log sink; the extension's Logger satisfies it structurally. */
export interface StateLogSink {
  info(message: string): void;
}

/** Injected so nothing here reaches for the wall clock directly. */
export type NowFn = () => string;

/**
 * TaskRepository backed by a JSON file under the repository's git directory.
 *
 * This is the source of truth for task metadata, and deliberately holds no
 * cache: the whole point of moving off the Memento is that more than one
 * process — the extension and a headless CLI — can act on the same repo, so a
 * cached view would go stale the moment the other one wrote.
 *
 * Writes re-read immediately before mutating, so two callers touching
 * *different* tasks cannot clobber each other. Two callers writing the *same*
 * task within the same read-write window still resolves last-writer-wins; a
 * lock belongs here if that ever proves to matter.
 */
export class FileTaskRepository implements TaskRepository {
  private readonly filePath: string;
  private readonly quarantinePath: string;

  constructor(
    gitCommonDir: string,
    private readonly io: StateFileIo,
    private readonly logger?: StateLogSink,
    private readonly now: NowFn = () => new Date().toISOString(),
  ) {
    this.filePath = taskStateFilePath(gitCommonDir);
    this.quarantinePath = taskStateQuarantinePath(gitCommonDir);
  }

  /** Absolute path of the state file, for logs and diagnostics. */
  get path(): string {
    return this.filePath;
  }

  private async read(): Promise<TaskWorkspace[]> {
    const outcome = decodeTaskStateFile(await this.io.read(this.filePath));

    for (const note of outcome.notes) {
      this.logger?.info(`Task state: ${note}`);
    }
    if (outcome.quarantined.length > 0) {
      // Fire-and-forget: a failed quarantine write must not block reading.
      void this.io
        .write(this.quarantinePath, encodeQuarantine(outcome.quarantined, this.now()))
        .catch((error: unknown) => {
          this.logger?.info(
            `Task state: could not write quarantine file: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }

    return outcome.tasks;
  }

  private async write(tasks: TaskWorkspace[]): Promise<void> {
    await this.io.write(this.filePath, encodeTaskStateFile(tasks));
  }

  /** True when the state file is present, i.e. this repo has been adopted. */
  async exists(): Promise<boolean> {
    return (await this.io.read(this.filePath)) !== undefined;
  }

  /**
   * Creates the file with an initial set of tasks, and only if it is still
   * absent. One atomic write rather than a save per task, so an interrupted
   * hand-off from the Memento cannot leave a half-adopted file behind — which
   * would then look adopted and never be retried.
   *
   * Returns false when a file appeared in the meantime; the caller should then
   * use what is already there.
   */
  async seed(tasks: TaskWorkspace[]): Promise<boolean> {
    if (await this.exists()) return false;
    await this.write(tasks);
    return true;
  }

  async getAll(): Promise<TaskWorkspace[]> {
    return this.read();
  }

  async getByRepository(repositoryRoot: string): Promise<TaskWorkspace[]> {
    // The store is already per-repository, but filtering keeps the contract
    // honest if a task was ever seeded with a foreign root.
    const key = normalizeRoot(repositoryRoot);
    const tasks = await this.read();
    return tasks.filter((t) => normalizeRoot(t.repositoryRoot) === key);
  }

  async get(id: string): Promise<TaskWorkspace | undefined> {
    return (await this.read()).find((t) => t.id === id);
  }

  async save(task: TaskWorkspace): Promise<void> {
    const tasks = await this.read();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) {
      tasks.push(task);
    } else {
      tasks[index] = task;
    }
    await this.write(tasks);
  }

  async delete(id: string): Promise<void> {
    const tasks = await this.read();
    const remaining = tasks.filter((t) => t.id !== id);
    // Nothing matched: skip the write rather than rewrite the file untouched,
    // so a delete of an unknown id cannot disturb a concurrent writer.
    if (remaining.length === tasks.length) return;
    await this.write(remaining);
  }
}
