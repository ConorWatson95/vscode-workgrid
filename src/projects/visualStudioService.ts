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

  /** Scans a worktree unless it has been scanned already. */
  async detect(worktreePath: string): Promise<VisualStudioProject | undefined> {
    const cached = this.cache.get(worktreePath);
    if (cached !== undefined || this.cache.has(worktreePath)) return cached;

    let result: VisualStudioProject | undefined;
    try {
      const files = await this.listFiles(worktreePath);
      const found = detectFromFiles(files);
      if (found) {
        result = { ...found, flavour: await this.classify(worktreePath, found.projects) };
      }
    } catch (error) {
      // Detection is cosmetic — never let it break the details view.
      this.logger.debug(`Visual Studio detection failed for ${worktreePath}: ${String(error)}`);
    }
    this.cache.set(worktreePath, result);
    return result;
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
