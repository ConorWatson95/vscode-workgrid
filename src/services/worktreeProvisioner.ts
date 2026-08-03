import * as fs from "node:fs";
import * as path from "node:path";
import { CopyEntry, resolveCopyPlan } from "../domain/worktreeCopyPlan";
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
  copyDirectory(from: string, to: string): void;
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
  copyDirectory: (from, to) => fs.cpSync(from, to, { recursive: true }),
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
}
