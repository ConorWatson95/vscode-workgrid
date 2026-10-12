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

/**
 * Records which release the stable copy came from.
 *
 * Two things now write the folder — VS Code on activation and `harnessRunner update`
 * from a GitHub release — and they need not agree. Without a version, an editor still on
 * last week's extension would put last week's server back over the one just downloaded,
 * every time it started. With one, the newer copy wins whichever writer runs last.
 */
export const BUNDLE_MARKER = "bundle.json";

/**
 * Whether version `a` is newer than `b`, comparing dotted numbers. Anything that is not
 * a version is never newer, so an unreadable marker never blocks an install.
 */
export function isNewerVersion(a: string | undefined, b: string | undefined): boolean {
  const parse = (value: string | undefined) =>
    value && /^\d+(\.\d+)*$/.test(value) ? value.split(".").map(Number) : undefined;
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return false;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** The version a stable copy records, or undefined when it records none. */
export function installedBundleVersion(
  targetDir: string,
  files: BundleFileSystem = nodeBundleFileSystem,
): string | undefined {
  try {
    const marker = JSON.parse(files.read(path.join(targetDir, BUNDLE_MARKER))?.toString() ?? "null");
    return typeof marker?.version === "string" ? marker.version : undefined;
  } catch {
    return undefined;
  }
}

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
  /** Set when the copy already there is from a newer release, so nothing was written. */
  keptNewer?: string;
}

export interface BundleInstallOptions {
  /** The release `sourceDir` belongs to. Absent writes as before and records nothing. */
  version?: string;
  /** Install even over a newer copy — an explicit downgrade. */
  force?: boolean;
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
  options: BundleInstallOptions = {},
): InstalledBundle | undefined {
  const server = path.join(targetDir, SERVER_BUNDLE_FILES[0]);
  const updated: string[] = [];
  try {
    const installed = installedBundleVersion(targetDir, files);
    if (!options.force && isNewerVersion(installed, options.version)) {
      logger.info(
        `Harness server bundle: kept ${installed} in ${targetDir}, which is newer than ${options.version}.`,
      );
      return { server, updated, keptNewer: installed };
    }
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
    if (options.version && installed !== options.version) {
      files.replace(
        path.join(targetDir, BUNDLE_MARKER),
        Buffer.from(`${JSON.stringify({ version: options.version })}
`),
      );
    }
  } catch (error) {
    // A copy is a convenience for another host; failing activation over it would trade
    // a stale dashboard for a broken extension.
    logger.warn(`Could not copy the harness server to ${targetDir}: ${String(error)}`);
    return undefined;
  }
  return { server, updated };
}
