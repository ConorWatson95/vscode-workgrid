import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../logging/logger";

/**
 * Copies the harness MCP server, and the runner it starts, to a path that does not
 * change between releases.
 *
 * VS Code installs each version into its own folder (`…task-workspaces-0.146.0`), so a
 * host configured with the server's path inside it kept running whichever release it
 * was set up against. Nothing said so: the old folder is not removed on upgrade, so the
 * old server still started, and simply lacked whatever the new release added. The
 * extension's global storage folder carries no version, so a copy there is current as
 * soon as the new release activates.
 *
 * **Both files, side by side.** The server starts the runner from its own directory
 * (`mcp/runLauncher.ts`), so copying the server alone would pair a new server with
 * whichever runner was there before.
 *
 * **Overwritten, never merged**, and only when the contents differ. Each file is written
 * beside its target and renamed over it, so a host starting the server mid-copy reads
 * the old file or the new one and never half of each. Node reads a script once at
 * start, so replacing it under a running server does not disturb that server.
 */

export const SERVER_BUNDLE_FILES = ["harnessMcpServer.js", "harnessRunner.js"] as const;

/** Directory name under the extension's global storage. */
export const SERVER_BUNDLE_DIR = "mcp-server";

/** Filesystem operations, injectable so the copy rules are testable. */
export interface BundleFileSystem {
  read(file: string): Buffer | undefined;
  mkdirp(directory: string): void;
  /** Writes `contents` to `target` so a reader sees either the old file or the new one. */
  replace(target: string, contents: Buffer): void;
}

export const nodeBundleFileSystem: BundleFileSystem = {
  read: (file) => {
    try {
      return fs.readFileSync(file);
    } catch {
      return undefined;
    }
  },
  mkdirp: (directory) => fs.mkdirSync(directory, { recursive: true }),
  replace: (target, contents) => {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, target);
  },
};

export interface InstalledBundle {
  /** The stable path a host should start: `node <server> --repo <path>`. */
  server: string;
  /** Files rewritten this time, for the log. Empty when everything was current. */
  updated: string[];
}

/**
 * Copies the bundle from `sourceDir` (the extension's `dist`) to `targetDir`.
 *
 * A file missing from the source is skipped rather than failing the rest: a development
 * build may not have bundled the runner, and the server is still worth keeping current.
 * Returns undefined only when the server itself is missing, since then there is nothing
 * a host could start.
 */
export function installServerBundle(
  sourceDir: string,
  targetDir: string,
  logger: Logger,
  files: BundleFileSystem = nodeBundleFileSystem,
): InstalledBundle | undefined {
  const server = path.join(targetDir, SERVER_BUNDLE_FILES[0]);
  const updated: string[] = [];
  try {
    files.mkdirp(targetDir);
    for (const name of SERVER_BUNDLE_FILES) {
      const contents = files.read(path.join(sourceDir, name));
      if (!contents) {
        logger.warn(`Harness server bundle: ${name} is not in ${sourceDir}, so it was not copied.`);
        if (name === SERVER_BUNDLE_FILES[0]) return undefined;
        continue;
      }
      const target = path.join(targetDir, name);
      const existing = files.read(target);
      if (existing && existing.equals(contents)) continue;
      files.replace(target, contents);
      updated.push(name);
    }
  } catch (error) {
    // A copy is a convenience for another host; failing activation over it would trade
    // a stale dashboard for a broken extension.
    logger.warn(`Could not copy the harness server to ${targetDir}: ${String(error)}`);
    return undefined;
  }
  return { server, updated };
}
