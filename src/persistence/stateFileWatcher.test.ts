import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logging/logger";
import { StateFileWatch, watchStateFile } from "./stateFileWatcher";

const quiet: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("watchStateFile", () => {
  let dir: string;
  let watch: StateFileWatch | undefined;

  afterEach(() => {
    watch?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fires once for an atomic replace, and again for the next one", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-watch-"));
    const target = path.join(dir, "state.json");
    fs.writeFileSync(target, "{}");
    let calls = 0;
    watch = watchStateFile(dir, "state.json", () => calls++, quiet, 50);

    // What `NodeStateFileIo` does: write beside it, then rename over it.
    fs.writeFileSync(`${target}.tmp`, '{"a":1}');
    fs.renameSync(`${target}.tmp`, target);
    await settle(300);
    expect(calls).toBe(1);

    // A watch on the file itself would have followed the replaced inode and missed this.
    fs.writeFileSync(`${target}.tmp`, '{"a":2}');
    fs.renameSync(`${target}.tmp`, target);
    await settle(300);
    expect(calls).toBe(2);
  });

  it("ignores the lock file beside it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-watch-"));
    let calls = 0;
    watch = watchStateFile(dir, "state.json", () => calls++, quiet, 50);

    fs.writeFileSync(path.join(dir, "state.json.lock"), "pid");
    await settle(300);
    expect(calls).toBe(0);
  });
});
