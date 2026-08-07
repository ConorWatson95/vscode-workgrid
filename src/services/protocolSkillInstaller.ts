import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROTOCOL_PLUGIN_MANIFEST,
  PROTOCOL_SKILL,
  PROTOCOL_SKILL_NAME,
} from "../agents/protocolSkill";
import { Logger } from "../logging/logger";

/**
 * Installs the harness's protocol skill where stage sessions can load it.
 *
 * **Under the git common dir**, beside `state.json`, for the reasons task state lives
 * there: it is harness-owned, one copy is shared by every worktree of the repository,
 * and a branch cannot edit the protocol it is subject to by committing to a file. It
 * is deliberately *not* written into a worktree, where it would appear in diffs and be
 * reviewed as though someone had authored it.
 *
 * Reaching it from a worktree is possible because `--plugin-dir` takes an absolute
 * path — probed on CLI 2.1.223 from an unrelated cwd, with the negative control run:
 * without the flag the CLI reports no such skill.
 *
 * **One-directional, always overwritten.** Never merged, and local edits never survive.
 * The moment an edit could persist, protocol drifts per machine — and protocol being
 * invariant is the entire reason it is a skill rather than prose in a prompt. Someone
 * who wants different behaviour wants a route change or a `StageContext` change.
 *
 * This is the same surface as the permission gate's settings file, and the same rule
 * applies: harness-owned agent configuration, nothing derived from a task, a branch or
 * a project file ever written into it.
 */

/** Directory name under the state dir. Also what `--plugin-dir` is pointed at. */
export const PLUGIN_DIR_NAME = "runtime-plugin";

/** Filesystem operations, injectable so the install rules are testable. */
export interface SkillFileSystem {
  mkdirp(directory: string): void;
  writeFile(target: string, contents: string): void;
  readFile(target: string): string | undefined;
}

export const nodeSkillFileSystem: SkillFileSystem = {
  mkdirp: (directory) => fs.mkdirSync(directory, { recursive: true }),
  writeFile: (target, contents) => fs.writeFileSync(target, contents, "utf8"),
  readFile: (target) => {
    try {
      return fs.readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  },
};

export interface InstalledSkill {
  /** Absolute path to pass as `--plugin-dir`. */
  pluginDir: string;
}

export class ProtocolSkillInstaller {
  constructor(
    private readonly logger: Logger,
    private readonly fileSystem: SkillFileSystem = nodeSkillFileSystem,
  ) {}

  /**
   * Ensures the plugin directory exists and matches this build, returning the path to
   * pass to the CLI.
   *
   * Returns `undefined` on any failure rather than throwing. A stage that runs without
   * the skill behaves as it did before the skill existed — the marker contract it is
   * actually held to lives in the prompt — so failing the stage over it would trade a
   * degraded run for no run at all.
   *
   * Content is compared before writing. Not to avoid the write, which is trivial, but
   * because the state directory is watched: rewriting an identical file on every stage
   * of every task is a stream of change events for something that never changes.
   */
  install(stateDir: string): InstalledSkill | undefined {
    const pluginDir = path.join(stateDir, PLUGIN_DIR_NAME);
    const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
    const skillPath = path.join(pluginDir, "skills", PROTOCOL_SKILL_NAME, "SKILL.md");

    try {
      this.writeIfChanged(manifestPath, PROTOCOL_PLUGIN_MANIFEST);
      this.writeIfChanged(skillPath, PROTOCOL_SKILL);
      return { pluginDir };
    } catch (error) {
      this.logger.warn(
        `Could not install the harness protocol skill at "${pluginDir}": ` +
          `${(error as Error).message}. Stages will run without it.`,
      );
      return undefined;
    }
  }

  private writeIfChanged(target: string, contents: string): void {
    if (this.fileSystem.readFile(target) === contents) return;
    this.fileSystem.mkdirp(path.dirname(target));
    this.fileSystem.writeFile(target, contents);
  }
}
