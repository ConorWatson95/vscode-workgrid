import * as fs from "node:fs";
import * as path from "node:path";
import { GateFileSystem } from "./permissionGateService";

/**
 * The real filesystem behind the permission gate.
 *
 * Kept apart from `PermissionGateService` so that service — which holds the
 * policy and all the sequencing worth testing — can be exercised entirely in
 * memory. Everything here swallows its errors: the gate is an enhancement, and a
 * failure to write a scratch file must never take a stage down with it.
 */
export const nodeGateFileSystem: GateFileSystem = {
  join: (...segments) => path.join(...segments),

  resolve: (target) => path.resolve(target),

  mkdirp(directory) {
    fs.mkdirSync(directory, { recursive: true });
  },

  writeFile(filePath, contents) {
    fs.writeFileSync(filePath, contents, "utf8");
  },

  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      // Most often a request read in the instant between create and rename.
      return undefined;
    }
  },

  removeFile(filePath) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* tidiness only */
    }
  },

  removeDirectory(directory) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* tidiness only */
    }
  },

  listFiles(directory) {
    try {
      return fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      // The inbox is removed on release, so a missing directory is expected.
      return [];
    }
  },
};
