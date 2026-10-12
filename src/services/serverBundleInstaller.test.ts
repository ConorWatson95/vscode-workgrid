import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BundleFileSystem,
  installedBundleVersion,
  installServerBundle,
  isNewerVersion,
} from "./serverBundleInstaller";

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

describe("installServerBundle with versions", () => {
  const dist = { "/dist/harnessMcpServer.js": "server v1", "/dist/harnessRunner.js": "runner v1" };

  it("records the release it installed", () => {
    const fs = memoryFiles(dist);
    installServerBundle("/dist", "/stable", logger, fs.files, { version: "0.148.0" });
    expect(installedBundleVersion("/stable", fs.files)).toBe("0.148.0");
  });

  it("never puts an older release back over a newer one, unless forced", () => {
    const fs = memoryFiles({
      ...dist,
      "/stable/harnessMcpServer.js": "server v2",
      "/stable/bundle.json": '{"version":"0.149.0"}',
    });
    const kept = installServerBundle("/dist", "/stable", logger, fs.files, { version: "0.148.0" });
    expect(kept).toMatchObject({ keptNewer: "0.149.0", updated: [] });
    expect(fs.text("/stable/harnessMcpServer.js")).toBe("server v2");

    installServerBundle("/dist", "/stable", logger, fs.files, { version: "0.148.0", force: true });
    expect(fs.text("/stable/harnessMcpServer.js")).toBe("server v1");
    expect(installedBundleVersion("/stable", fs.files)).toBe("0.148.0");
  });

  it("installs over a copy that records no version", () => {
    const fs = memoryFiles({ ...dist, "/stable/harnessMcpServer.js": "server v0" });
    installServerBundle("/dist", "/stable", logger, fs.files, { version: "0.148.0" });
    expect(fs.text("/stable/harnessMcpServer.js")).toBe("server v1");
  });
});

describe("isNewerVersion", () => {
  it("compares dotted numbers, and never calls a non-version newer", () => {
    expect(isNewerVersion("0.149.0", "0.148.9")).toBe(true);
    expect(isNewerVersion("0.148.0", "0.148.0")).toBe(false);
    expect(isNewerVersion("1.0", "0.999.999")).toBe(true);
    expect(isNewerVersion("dev", "0.1.0")).toBe(false);
    expect(isNewerVersion(undefined, "0.1.0")).toBe(false);
  });
});
