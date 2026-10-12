import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BundleFileSystem, installServerBundle } from "./serverBundleInstaller";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function memoryFiles(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed).map(([file, text]) => [path.normalize(file), Buffer.from(text)]));
  const writes: string[] = [];
  const files: BundleFileSystem = {
    read: (file) => store.get(path.normalize(file)),
    mkdirp: () => undefined,
    replace: (target, contents) => {
      writes.push(path.basename(target));
      store.set(path.normalize(target), contents);
    },
  };
  return { files, writes, text: (file: string) => store.get(path.normalize(file))?.toString() };
}

describe("installServerBundle", () => {
  it("copies the server and the runner it starts, side by side", () => {
    const fs = memoryFiles({ "/dist/harnessMcpServer.js": "server v2", "/dist/harnessRunner.js": "runner v2" });
    const installed = installServerBundle("/dist", "/stable", logger, fs.files);
    expect(installed?.server).toBe(path.join("/stable", "harnessMcpServer.js"));
    expect(fs.text("/stable/harnessRunner.js")).toBe("runner v2");
    expect(installed?.updated).toEqual(["harnessMcpServer.js", "harnessRunner.js"]);
  });

  it("rewrites only what changed", () => {
    const fs = memoryFiles({
      "/dist/harnessMcpServer.js": "server v2",
      "/dist/harnessRunner.js": "runner v2",
      "/stable/harnessMcpServer.js": "server v2",
      "/stable/harnessRunner.js": "runner v1",
    });
    expect(installServerBundle("/dist", "/stable", logger, fs.files)?.updated).toEqual(["harnessRunner.js"]);
    expect(fs.writes).toEqual(["harnessRunner.js"]);
  });

  it("keeps the server current when the runner was not bundled, and gives up without a server", () => {
    const partial = memoryFiles({ "/dist/harnessMcpServer.js": "server v2" });
    expect(installServerBundle("/dist", "/stable", logger, partial.files)?.updated).toEqual(["harnessMcpServer.js"]);
    expect(installServerBundle("/empty", "/stable", logger, memoryFiles({}).files)).toBeUndefined();
  });

  it("never fails the caller over a copy", () => {
    const failing: BundleFileSystem = {
      read: () => Buffer.from("x"),
      mkdirp: () => {
        throw new Error("EACCES");
      },
      replace: () => undefined,
    };
    expect(installServerBundle("/dist", "/stable", logger, failing)).toBeUndefined();
  });
});
