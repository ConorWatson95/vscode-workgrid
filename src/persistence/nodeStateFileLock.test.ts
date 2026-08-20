import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeStateFileLock } from "./nodeStateFileLock";
import { DEFAULT_LOCK_POLICY, lockPathFor } from "./stateFileLock";

/**
 * Exercised against a real filesystem, deliberately. The whole mechanism is
 * `wx` — an exclusive create — so a fake would test the parts that cannot fail.
 */
describe("NodeStateFileLock", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "state-lock-"));
    file = path.join(dir, "state.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("serialises two holders", async () => {
    const order: string[] = [];
    const a = new NodeStateFileLock(file);
    const b = new NodeStateFileLock(file);

    const first = a.withLock(async () => {
      order.push("a in");
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push("a out");
    });
    // Long enough that `a` holds it, short enough to be inside its 40ms.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = b.withLock(async () => {
      order.push("b in");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["a in", "a out", "b in"]);
  });

  it("removes the lock file afterwards", async () => {
    await new NodeStateFileLock(file).withLock(async () => undefined);

    await expect(fs.access(lockPathFor(file))).rejects.toThrow();
  });

  it("releases when the operation throws, and rethrows", async () => {
    const lock = new NodeStateFileLock(file);

    await expect(
      lock.withLock(async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");

    await expect(fs.access(lockPathFor(file))).rejects.toThrow();
  });

  // A killed process leaves nothing behind but its lock file, which is the
  // failure this whole area is about, one level down.
  it("breaks a lock left by a process that died", async () => {
    await fs.writeFile(
      lockPathFor(file),
      JSON.stringify({ owner: "999-0", at: "2026-08-20T12:00:00.000Z" }),
    );
    const lock = new NodeStateFileLock(file, undefined, DEFAULT_LOCK_POLICY, () =>
      "2026-08-20T13:00:00.000Z",
    );

    let ran = false;
    await lock.withLock(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it("breaks an unreadable lock rather than waiting it out", async () => {
    await fs.writeFile(lockPathFor(file), "{ half-writ");

    let ran = false;
    await new NodeStateFileLock(file).withLock(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  // Fail open. An unwritable transition is the failure the lock exists to
  // prevent, so a lock that cannot be taken must never stop the write.
  it("proceeds without the lock, and says so, when it cannot be taken", async () => {
    const messages: string[] = [];
    // A directory cannot be replaced by `wx`, so this can never be acquired.
    await fs.mkdir(lockPathFor(file));
    const lock = new NodeStateFileLock(
      file,
      { info: (m) => messages.push(m) },
      { ...DEFAULT_LOCK_POLICY, giveUpAfterMs: 30, retryEveryMs: 5 },
    );

    let ran = false;
    await lock.withLock(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(messages.join(" ")).toContain("without it");
  });
});
