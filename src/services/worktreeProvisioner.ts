import * as fs from "node:fs";
import * as path from "node:path";
import { CopyEntry, resolveCopyPlan } from "../domain/worktreeCopyPlan";
import { SiblingLinkEntry, resolveSiblingLinkPlan } from "../domain/siblingLinkPlan";
import { Logger } from "../logging/logger";

/**
 * Copies configured files into a newly created worktree.
 *
 * Failures here are reported but never fatal: the worktree is already created and
 * usable, so refusing to hand it over because an optional local settings file was
 * missing would be worse than proceeding without it.
 */

export interface ProvisionResult {
  copied: string[];
  /** Sources that did not exist. Common and benign — logged, not an error. */
  missing: string[];
  /** Genuine failures (permissions, unreadable source) and rejected entries. */
  problems: string[];
}

/** Filesystem operations, injectable so the copy logic is testable. */
export interface CopyFileSystem {
  exists(target: string): boolean;
  isDirectory(target: string): boolean;
  mkdirp(directory: string): void;
  copyFile(from: string, to: string): void;
  /**
   * Copies a directory tree **without replacing files that already exist**.
   *
   * That exclusion is the feature, not an optimisation. A fresh worktree contains
   * exactly what git tracks, so anything already at the destination is a tracked
   * file — and this setting exists for the files git does *not* track. Copying over
   * one wrote the main checkout's copy into the worktree, and a task nobody had
   * touched opened with a modified file: identical content, different line endings,
   * because the two checkouts had normalised differently.
   *
   * It cost a real morning of "why is this task dirty", which is exactly the sort of
   * doubt that makes an isolated worktree stop feeling isolated.
   */
  copyDirectory(from: string, to: string): void;
  /** Where a link points, or undefined when the path is not a link. */
  readLink(target: string): string | undefined;
  /** Removes a link. Only ever called on a path `readLink` resolved. */
  removeLink(target: string): void;
  /** Creates a directory link — a junction on Windows, a symlink elsewhere. */
  createDirectoryLink(linkPath: string, targetPath: string): void;
}

export const nodeCopyFileSystem: CopyFileSystem = {
  exists: (target) => fs.existsSync(target),
  isDirectory: (target) => {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  },
  mkdirp: (directory) => fs.mkdirSync(directory, { recursive: true }),
  copyFile: (from, to) => fs.copyFileSync(from, to),
  // `force: false` skips files already at the destination; `errorOnExist: false`
  // makes that a skip rather than a throw. Verified on Node 24 (Windows): an
  // existing destination file keeps its own bytes and the rest of the tree still
  // copies, including nested directories.
  copyDirectory: (from, to) =>
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false }),
  readLink: (target) => {
    try {
      // lstat, not stat: stat follows the link and would report the *target's*
      // kind, so a junction to a directory would be indistinguishable from a real
      // directory — and the whole safety rule below turns on telling them apart.
      if (!fs.lstatSync(target).isSymbolicLink()) return undefined;
      return fs.readlinkSync(target);
    } catch {
      return undefined;
    }
  },
  removeLink: (target) => fs.unlinkSync(target),
  createDirectoryLink: (linkPath, targetPath) =>
    // "junction" on Windows: it needs no elevation, where a directory symlink
    // requires either developer mode or an administrator, and this runs as
    // whatever the editor happens to be. Ignored on other platforms, which get a
    // normal directory symlink.
    fs.symlinkSync(targetPath, linkPath, "junction"),
};

export class WorktreeProvisioner {
  constructor(
    private readonly logger: Logger,
    private readonly fileSystem: CopyFileSystem = nodeCopyFileSystem,
  ) {}

  provision(
    entries: readonly CopyEntry[],
    repositoryRoot: string,
    worktreePath: string,
  ): ProvisionResult {
    const result: ProvisionResult = { copied: [], missing: [], problems: [] };
    if (entries.length === 0) return result;

    const plan = resolveCopyPlan(entries, repositoryRoot, worktreePath);
    result.problems.push(...plan.problems);

    for (const operation of plan.operations) {
      if (!this.fileSystem.exists(operation.from)) {
        result.missing.push(operation.label);
        continue;
      }
      try {
        if (this.fileSystem.isDirectory(operation.from)) {
          this.fileSystem.mkdirp(operation.to);
          this.fileSystem.copyDirectory(operation.from, operation.to);
        } else {
          // The destination's parent may not exist yet — a fresh worktree has no
          // .claude/ directory, which is the whole reason for this feature.
          this.fileSystem.mkdirp(path.dirname(operation.to));
          this.fileSystem.copyFile(operation.from, operation.to);
        }
        result.copied.push(operation.label);
      } catch (error) {
        result.problems.push(
          `Could not copy "${operation.label}": ${(error as Error).message}`,
        );
      }
    }

    for (const entry of result.copied) {
      this.logger.info(`Copied into worktree: ${entry}`);
    }
    for (const entry of result.missing) {
      this.logger.info(`Nothing to copy for "${entry}" — source does not exist.`);
    }
    for (const problem of result.problems) {
      this.logger.warn(`Worktree provisioning: ${problem}`);
    }

    return result;
  }

  /**
   * Ensures the configured sibling links exist beside the worktrees.
   *
   * Idempotent, and deliberately timid. The one rule that matters: **a path that is
   * not already a link is never touched**. The links live in the worktree parent
   * directory, which on a normal setup is also where real repositories live, so a
   * mistyped name points at a working clone — and the difference between "repoint
   * this link" and "delete this repository" is a single `lstat`.
   *
   * Failures are reported and never fatal, like copying: the worktree is created and
   * usable, and a build that cannot find a sibling says so far more clearly than a
   * task that refused to be handed over.
   */
  linkSiblings(
    entries: readonly SiblingLinkEntry[],
    repositoryRoot: string,
    worktreePath: string,
  ): ProvisionResult {
    const result: ProvisionResult = { copied: [], missing: [], problems: [] };
    if (entries.length === 0) return result;

    const plan = resolveSiblingLinkPlan(entries, repositoryRoot, worktreePath);
    result.problems.push(...plan.problems);

    for (const operation of plan.operations) {
      if (!this.fileSystem.exists(operation.targetPath)) {
        result.missing.push(operation.label);
        continue;
      }

      try {
        const existing = this.fileSystem.readLink(operation.linkPath);
        if (existing === undefined && this.fileSystem.exists(operation.linkPath)) {
          // A real directory or file. Almost always the sibling repository itself,
          // cloned where the link would go — in which case the references already
          // resolve and there is nothing to do.
          result.problems.push(
            `Not linking "${operation.linkPath}": something is already there that is ` +
              `not a link. Remove it yourself if it should be one.`,
          );
          continue;
        }

        if (existing !== undefined) {
          if (samePath(existing, operation.targetPath)) continue; // already correct
          // Safe to remove: `readLink` returned, so this is a link and unlinking it
          // destroys nothing but the link.
          this.fileSystem.removeLink(operation.linkPath);
        }

        this.fileSystem.mkdirp(path.dirname(operation.linkPath));
        this.fileSystem.createDirectoryLink(operation.linkPath, operation.targetPath);
        result.copied.push(operation.label);
      } catch (error) {
        result.problems.push(
          `Could not link "${operation.label}": ${(error as Error).message}`,
        );
      }
    }

    for (const entry of result.copied) {
      this.logger.info(`Linked beside worktrees: ${entry}`);
    }
    for (const entry of result.missing) {
      this.logger.info(`Not linking "${entry}" — the target does not exist.`);
    }
    for (const problem of result.problems) {
      this.logger.warn(`Sibling links: ${problem}`);
    }

    return result;
  }
}

/** Case-insensitive with separators normalised, because Windows is both. */
function samePath(a: string, b: string): boolean {
  const clean = (value: string) =>
    path.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
  return clean(a) === clean(b);
}
