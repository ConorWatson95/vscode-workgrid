import * as fs from "node:fs";
import * as path from "node:path";
import { ChatItem } from "./streamJson";
import {
  resolveProjectDir,
  readTranscriptTitle,
  fallbackTitle,
  loadItemsFromFileSync,
} from "./transcriptReader";

export interface ArchivedSession {
  id: string;
  title: string;
  mtimeMs: number;
  /** Absolute path to the archived transcript file. */
  file: string;
}

/**
 * Durable archive for a task's Claude transcripts. Worktrees fragment Claude's
 * per-directory history and removing a worktree orphans it, so we copy a task's
 * transcripts into the extension's own storage before the worktree is deleted —
 * history is then never lost. vscode-free (pure fs) so it is unit-testable.
 */
export class SessionArchive {
  constructor(private readonly baseDir: string) {}

  private taskDir(taskId: string): string {
    return path.join(this.baseDir, taskId);
  }

  /**
   * Copies every transcript in the worktree's Claude project bucket into the
   * task's archive directory. Returns the archived sessions (newest first).
   */
  archiveWorktree(
    homeDir: string,
    worktreePath: string,
    taskId: string,
  ): ArchivedSession[] {
    const source = resolveProjectDir(homeDir, worktreePath);
    if (!source) return [];

    const dest = this.taskDir(taskId);
    let files: string[];
    try {
      fs.mkdirSync(dest, { recursive: true });
      files = fs.readdirSync(source).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const archived: ArchivedSession[] = [];
    for (const file of files) {
      const to = path.join(dest, file);
      try {
        fs.copyFileSync(path.join(source, file), to);
        const id = file.replace(/\.jsonl$/, "");
        archived.push({
          id,
          title: readTranscriptTitle(to) ?? fallbackTitle(id),
          mtimeMs: fs.statSync(to).mtimeMs,
          file: to,
        });
      } catch {
        /* skip unreadable file */
      }
    }
    return archived.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  loadItems(file: string, maxItems?: number): ChatItem[] {
    return loadItemsFromFileSync(file, maxItems);
  }
}
