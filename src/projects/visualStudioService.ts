import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Logger } from "../logging/logger";
import {
  DotnetFlavour,
  VisualStudioProject,
  VsWhereInstance,
  classifyProjectXml,
  combineFlavours,
  detectFromFiles,
  pickDevenv,
} from "./visualStudio";

/** How many project files are read to determine the flavour. */
const MAX_CLASSIFY = 5;

/**
 * Detects whether a worktree is a Visual Studio solution, and finds the
 * installed `devenv.exe` to open it with.
 *
 * Results are cached per worktree: this runs on every details render, and the
 * answer only changes when a solution is added or removed.
 */
export class VisualStudioService {
  private readonly cache = new Map<string, VisualStudioProject | undefined>();
  private devenv: string | undefined | null = null; // null = not yet resolved

  constructor(
    private readonly logger: Logger,
    private readonly listFiles: (worktreePath: string) => Promise<string[]>,
  ) {}

  /**
   * Scans a worktree unless it has been scanned already.
   *
   * **A scan that could not run is never cached.** It used to be: the result was stored
   * on every path including the `catch`, and the injected lister answers a git failure
   * with an empty array — so one failed `git ls-files` became a permanent "this worktree
   * has no solution" for the lifetime of the window, and "Open in Visual Studio" opened
   * the *folder* instead of the .sln from then on. Nothing said why, because falling
   * back to the folder is a deliberate feature.
   *
   * That is absence of evidence cached as evidence of absence, which this codebase
   * refuses everywhere else — an activity record that is missing means unmeasured, not
   * zero. The distinction is worth the retry: caching exists because this runs on every
   * details render, and a repository with no solution still answers from cache.
   */
  async detect(worktreePath: string): Promise<VisualStudioProject | undefined> {
    if (this.cache.has(worktreePath)) return this.cache.get(worktreePath);

    let files: string[];
    try {
      files = await this.listFiles(worktreePath);
    } catch (error) {
      // Detection is cosmetic — never let it break the details view. But not cached, so
      // the next invocation tries again rather than inheriting this answer.
      this.logger.debug(`Visual Studio detection failed for ${worktreePath}: ${String(error)}`);
      return undefined;
    }

    // An empty listing is the same fault wearing different clothes: a checkout with no
    // files at all is a listing that did not work, and the lister cannot tell us so
    // because it reports a git failure as an empty array. Treated as unscanned.
    if (files.length === 0) {
      this.logger.debug(`Visual Studio detection found no files in ${worktreePath}.`);
      return undefined;
    }

    let result: VisualStudioProject | undefined;
    const found = detectFromFiles(files);
    if (found) {
      try {
        result = { ...found, flavour: await this.classify(worktreePath, found.projects) };
      } catch (error) {
        // The solution is what the command needs; the flavour is decoration. Losing the
        // classification must not lose the .sln with it — that was the original bug's
        // shape, one layer in.
        this.logger.debug(`Visual Studio flavour detection failed: ${String(error)}`);
        result = { ...found, flavour: "unknown" };
      }
    }
    this.cache.set(worktreePath, result);
    return result;
  }

  /** Forgets a worktree's scan, so the next detect runs afresh. */
  forget(worktreePath: string): void {
    this.cache.delete(worktreePath);
  }

  private async classify(worktreePath: string, projects: string[]): Promise<DotnetFlavour> {
    const flavours: DotnetFlavour[] = [];
    for (const project of projects.slice(0, MAX_CLASSIFY)) {
      try {
        const xml = await fs.readFile(path.join(worktreePath, project), "utf8");
        flavours.push(classifyProjectXml(xml));
      } catch {
        /* unreadable project file — ignore it */
      }
    }
    return combineFlavours(flavours);
  }

  /**
   * Path to `devenv.exe`, via the `vswhere` tool that ships with the VS
   * installer. Resolves to undefined when Visual Studio isn't installed, in
   * which case callers fall back to the shell's file association.
   */
  async findDevenv(): Promise<string | undefined> {
    if (this.devenv !== null) return this.devenv;
    this.devenv = await this.runVswhere();
    return this.devenv;
  }

  private runVswhere(): Promise<string | undefined> {
    if (process.platform !== "win32") return Promise.resolve(undefined);
    const vswhere = path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe",
    );
    return new Promise((resolve) => {
      execFile(
        vswhere,
        ["-all", "-prerelease", "-products", "*", "-format", "json", "-utf8"],
        { windowsHide: true, timeout: 10_000 },
        (error, stdout) => {
          if (error) {
            this.logger.debug(`vswhere failed: ${error.message}`);
            resolve(undefined);
            return;
          }
          let instances: VsWhereInstance[];
          try {
            const parsed: unknown = JSON.parse(stdout);
            instances = Array.isArray(parsed) ? (parsed as VsWhereInstance[]) : [];
          } catch {
            this.logger.debug("vswhere returned unparseable JSON.");
            resolve(undefined);
            return;
          }
          const devenv = pickDevenv(instances);
          this.logger.info(`Visual Studio: ${devenv ?? "not found"}`);
          resolve(devenv);
        },
      );
    });
  }
}
