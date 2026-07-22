import * as vscode from "vscode";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { TaskRepository, normalizeRoot } from "./taskRepository";

const STORAGE_KEY = "taskWorkspaces.tasks";
const SCHEMA_VERSION = 1;

interface StoredState {
  schemaVersion: number;
  tasks: TaskWorkspace[];
}

/**
 * TaskRepository backed by VS Code global state (a Memento). Global (not
 * workspace) state so tasks survive across windows and are keyed by
 * repositoryRoot. Stores a versioned JSON envelope to allow future migrations.
 */
export class ExtensionStateTaskRepository implements TaskRepository {
  constructor(private readonly memento: vscode.Memento) {}

  private read(): TaskWorkspace[] {
    const state = this.memento.get<StoredState>(STORAGE_KEY);
    if (!state || state.schemaVersion !== SCHEMA_VERSION) {
      return [];
    }
    return state.tasks;
  }

  private async write(tasks: TaskWorkspace[]): Promise<void> {
    const state: StoredState = { schemaVersion: SCHEMA_VERSION, tasks };
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
