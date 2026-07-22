import { TaskWorkspace } from "../domain/taskWorkspace";

/**
 * Persistence boundary for task metadata. Services depend on this interface;
 * the VS Code Memento-backed implementation and the in-memory test fake both
 * satisfy it, keeping service logic testable without the extension host.
 */
export interface TaskRepository {
  getAll(): Promise<TaskWorkspace[]>;
  getByRepository(repositoryRoot: string): Promise<TaskWorkspace[]>;
  get(id: string): Promise<TaskWorkspace | undefined>;
  save(task: TaskWorkspace): Promise<void>;
  delete(id: string): Promise<void>;
}

/** In-memory implementation, used by tests and as a safe default. */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, TaskWorkspace>();

  async getAll(): Promise<TaskWorkspace[]> {
    return [...this.tasks.values()];
  }

  async getByRepository(repositoryRoot: string): Promise<TaskWorkspace[]> {
    const key = normalizeRoot(repositoryRoot);
    return [...this.tasks.values()].filter(
      (t) => normalizeRoot(t.repositoryRoot) === key,
    );
  }

  async get(id: string): Promise<TaskWorkspace | undefined> {
    return this.tasks.get(id);
  }

  async save(task: TaskWorkspace): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
  }
}

export function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
