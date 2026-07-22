import * as vscode from "vscode";
import { ArchivedSession } from "../agents/sessionArchive";

export interface ArchivedTaskHistory {
  taskId: string;
  name: string;
  branchName: string;
  archivedAt: string;
  sessions: ArchivedSession[];
}

const KEY = "taskWorkspaces.archivedHistory";

/**
 * Durable index of Claude session transcripts archived when tasks are removed,
 * so history survives worktree deletion. Backed by global state.
 */
export class ArchivedHistoryRepository {
  constructor(private readonly memento: vscode.Memento) {}

  getAll(): ArchivedTaskHistory[] {
    return this.memento.get<ArchivedTaskHistory[]>(KEY, []);
  }

  get(taskId: string): ArchivedTaskHistory | undefined {
    return this.getAll().find((e) => e.taskId === taskId);
  }

  async add(entry: ArchivedTaskHistory): Promise<void> {
    const all = this.getAll().filter((e) => e.taskId !== entry.taskId);
    all.push(entry);
    await this.memento.update(KEY, all);
  }
}
