import * as fs from "node:fs";
import * as path from "node:path";

export interface SlashCommand {
  /** Full command as typed, e.g. "/plan" or "/git:commit". */
  name: string;
  /** "project", "user", or "built-in". */
  source: "project" | "user" | "built-in";
}

/**
 * A small set of commonly available built-in commands. These are passed through
 * to the CLI as-is; the CLI decides what it supports in non-interactive mode.
 */
export const BUILTIN_SLASH_COMMANDS: readonly string[] = [
  "/clear",
  "/compact",
  "/review",
  "/pr-comments",
  "/init",
];

/**
 * Discovers custom slash commands from `.claude/commands` directories. A file
 * `foo.md` becomes `/foo`; a nested `git/commit.md` becomes `/git:commit`
 * (matching Claude Code's namespacing). Missing directories are ignored.
 *
 * `projectDir` is the worktree's `.claude/commands`; `userDir` is the user-level
 * one. Project commands take precedence on name clashes.
 */
export function scanSlashCommands(
  projectCommandsDir: string,
  userCommandsDir: string,
): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();

  const add = (name: string, source: SlashCommand["source"]) => {
    if (!seen.has(name)) seen.set(name, { name, source });
  };

  for (const cmd of scanDir(projectCommandsDir)) add(cmd, "project");
  for (const cmd of scanDir(userCommandsDir)) add(cmd, "user");
  for (const cmd of BUILTIN_SLASH_COMMANDS) add(cmd, "built-in");

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Recursively collects `/name` entries for .md files under a directory. */
function scanDir(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, prefix: string[]) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // directory absent or unreadable
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...prefix, entry.name]);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stem = entry.name.slice(0, -3);
        const name = "/" + [...prefix, stem].join(":");
        results.push(name);
      }
    }
  };
  walk(root, []);
  return results;
}
