import * as fs from "node:fs";
import * as path from "node:path";
import { MergeResult, mergeAllowRules } from "../domain/permissionRules";
import { Logger } from "../logging/logger";

/** Where a project's local (git-ignored) Claude settings live. */
export const LOCAL_SETTINGS_RELATIVE_PATH = ".claude/settings.local.json";

/** The filesystem operations this needs, injected so the merge stays testable. */
export interface SettingsFileSystem {
  read(file: string): string | undefined;
  write(file: string, contents: string): void;
  mkdirp(directory: string): void;
}

export const nodeSettingsFileSystem: SettingsFileSystem = {
  read: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  write: (file, contents) => fs.writeFileSync(file, contents, "utf8"),
  mkdirp: (directory) => fs.mkdirSync(directory, { recursive: true }),
};

/**
 * Adds allow rules to a project's `.claude/settings.local.json`.
 *
 * Written to the **repository root**, not a worktree: that is the file the
 * extension copies into each new worktree, so a rule added there applies to every
 * future task rather than only the one that hit the refusal.
 */
export class PermissionRulesService {
  constructor(
    private readonly logger: Logger,
    private readonly fileSystem: SettingsFileSystem = nodeSettingsFileSystem,
  ) {}

  addAllowRules(
    repositoryRoot: string,
    rules: readonly string[],
  ): MergeResult & { file: string } {
    const file = path.join(repositoryRoot, LOCAL_SETTINGS_RELATIVE_PATH);
    const raw = this.fileSystem.read(file);

    let parsed: unknown;
    if (raw !== undefined && raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // Refuse rather than replace: this file is hand-edited and read by the
        // CLI, so overwriting unparseable content could revoke real grants.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Could not parse ${file}: ${message}`);
        return {
          file,
          added: [],
          alreadyPresent: [],
          problem: `${LOCAL_SETTINGS_RELATIVE_PATH} is not valid JSON, so it was left untouched.`,
        };
      }
    }

    const merged = mergeAllowRules(parsed, rules);
    if (merged.problem || !merged.settings) return { ...merged, file };

    try {
      this.fileSystem.mkdirp(path.dirname(file));
      this.fileSystem.write(file, `${JSON.stringify(merged.settings, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not write ${file}: ${message}`);
      return {
        file,
        added: [],
        alreadyPresent: merged.alreadyPresent,
        problem: `Could not write ${LOCAL_SETTINGS_RELATIVE_PATH}: ${message}`,
      };
    }

    this.logger.info(
      `Added ${merged.added.length} allow rule(s) to ${file}: ${merged.added.join(", ")}`,
    );
    return { ...merged, file };
  }
}
