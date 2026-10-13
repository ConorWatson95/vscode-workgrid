import * as vscode from "vscode";
import { ArchivedTaskHistory, readArchivedHistories, writeArchivedHistory } from "./archivedHistoryFiles";

export type { ArchivedTaskHistory };

const KEY = "taskWorkspaces.archivedHistory";

/**
 * Durable index of Claude session transcripts archived when tasks are removed,
 * so history survives worktree deletion. Backed by global state, merged with the
 * records a removal outside VS Code leaves in the archive directory.
 */
export class ArchivedHistoryRepository {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly baseDir: string,
  ) {}

  getAll(): ArchivedTaskHistory[] {
    const stored = this.memento.get<ArchivedTaskHistory[]>(KEY, []);
    const known = new Set(stored.map((entry) => entry.taskId));
    return [...stored, ...readArchivedHistories(this.baseDir).filter((entry) => !known.has(entry.taskId))];
  }

  get(taskId: string): ArchivedTaskHistory | undefined {
    return this.getAll().find((e) => e.taskId === taskId);
  }

  async add(entry: ArchivedTaskHistory): Promise<void> {
    const all = this.memento.get<ArchivedTaskHistory[]>(KEY, []).filter((e) => e.taskId !== entry.taskId);
    all.push(entry);
    await this.memento.update(KEY, all);
    try {
      writeArchivedHistory(this.baseDir, entry);
    } catch {
      /* the global-state copy is enough for this window */
    }
  }
}
