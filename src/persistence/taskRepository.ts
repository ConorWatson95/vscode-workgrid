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
  /**
   * Read-modify-write of one task with no other write interleaved.
   *
   * `save` replaces a whole task with a copy the caller read *earlier* — often
   * before a dialog the operator then sat on for a minute — so a write landing in
   * between from another client is silently overwritten, and two clients looking
   * at the same gate can both approve it. `change` is given the task as it stands
   * at the moment of writing, inside the same guarantee `save` has, and decides
   * against that. Returning `undefined` writes nothing.
   *
   * `change` must be synchronous and must not throw: it runs while the store is
   * held.
   */
  update(
    id: string,
    change: (current: TaskWorkspace | undefined) => TaskWorkspace | undefined,
  ): Promise<TaskWorkspace | undefined>;
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

  async update(
    id: string,
    change: (current: TaskWorkspace | undefined) => TaskWorkspace | undefined,
  ): Promise<TaskWorkspace | undefined> {
    const next = change(this.tasks.get(id));
    if (next) this.tasks.set(next.id, next);
    return next;
  }
}

export function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
