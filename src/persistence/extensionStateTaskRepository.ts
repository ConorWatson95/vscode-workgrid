import * as vscode from "vscode";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { TaskRepository, normalizeRoot } from "./taskRepository";
import {
  CURRENT_SCHEMA_VERSION,
  StoredState,
  migrateStoredState,
} from "./storedStateMigration";
import { Logger } from "../logging/logger";

const STORAGE_KEY = "taskWorkspaces.tasks";
/** Where unreadable state is parked, so a bad blob is recoverable by hand. */
const QUARANTINE_KEY = "taskWorkspaces.tasks.quarantine";

/**
 * TaskRepository backed by VS Code global state (a Memento). Global (not
 * workspace) state so tasks survive across windows and are keyed by
 * repositoryRoot.
 *
 * Reads go through `migrateStoredState`, which never discards data: an earlier
 * version of this class returned `[]` on any schema mismatch, which would have
 * wiped every task's metadata and left the user's worktrees looking like
 * unadopted orphans. Migration logic lives in a `vscode`-free module so it is
 * covered by unit tests.
 */
export class ExtensionStateTaskRepository implements TaskRepository {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly logger?: Logger,
  ) {}

  private read(): TaskWorkspace[] {
    const outcome = migrateStoredState(this.memento.get<unknown>(STORAGE_KEY));

    for (const note of outcome.notes) {
      this.logger?.info(`Task state migration: ${note}`);
    }
    if (outcome.quarantined.length > 0) {
      // Fire-and-forget: a failed quarantine write must not block reading.
      void this.memento.update(QUARANTINE_KEY, {
        quarantinedAt: new Date().toISOString(),
        entries: outcome.quarantined,
      });
    }

    return outcome.tasks;
  }

  private async write(tasks: TaskWorkspace[]): Promise<void> {
    const state: StoredState = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tasks,
    };
    await this.memento.update(STORAGE_KEY, state);
  }

  async getAll(): Promise<TaskWorkspace[]> {
    return this.read();
  }

  async getByRepository(repositoryRoot: string): Promise<TaskWorkspace[]> {
    const key = normalizeRoot(repositoryRoot);
    return this.read().filter((t) => normalizeRoot(t.repositoryRoot) === key);
  }

  async get(id: string): Promise<TaskWorkspace | undefined> {
    return this.read().find((t) => t.id === id);
  }

  async save(task: TaskWorkspace): Promise<void> {
    const tasks = this.read();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) {
      tasks.push(task);
    } else {
      tasks[index] = task;
    }
    await this.write(tasks);
  }

  async delete(id: string): Promise<void> {
    await this.write(this.read().filter((t) => t.id !== id));
  }
}
