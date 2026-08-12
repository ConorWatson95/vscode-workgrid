import { describe, expect, it } from "vitest";
import { isTransientFsError, retryOnTransientFsError } from "./transientFsError";

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const noSleep = async () => undefined;

describe("isTransientFsError", () => {
  it("treats a Windows lock as transient", () => {
    // The exact one that reached a user: rename onto a state.json something else
    // had open, reported as "operation not permitted".
    expect(isTransientFsError(fsError("EPERM"))).toBe(true);
    expect(isTransientFsError(fsError("EBUSY"))).toBe(true);
  });

  it("does not treat a missing path or a plain error as transient", () => {
    expect(isTransientFsError(fsError("ENOENT"))).toBe(false);
    expect(isTransientFsError(new Error("boom"))).toBe(false);
    expect(isTransientFsError(undefined)).toBe(false);
  });
});

describe("retryOnTransientFsError", () => {
  it("returns the first success without sleeping", async () => {
    let calls = 0;
    const result = await retryOnTransientFsError(
      async () => {
        calls++;
        return "written";
      },
      { sleep: noSleep },
    );
    expect(result).toBe("written");
    expect(calls).toBe(1);
  });

  it("retries a lock that clears", async () => {
    let calls = 0;
    const result = await retryOnTransientFsError(
      async () => {
        calls++;
        if (calls < 3) throw fsError("EPERM");
        return "written";
      },
      { sleep: noSleep },
    );
    expect(result).toBe("written");
    expect(calls).toBe(3);
  });

  it("gives up with the real error, so a persistent failure stays diagnosable", async () => {
    let calls = 0;
    await expect(
      retryOnTransientFsError(
        async () => {
          calls++;
          throw fsError("EPERM");
        },
        { attempts: 4, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(4);
  });

  // A real permissions problem or a missing directory must fail immediately:
  // retrying one turns a misconfiguration into unexplained slowness.
  it("does not retry an error that will not clear", async () => {
    let calls = 0;
    await expect(
      retryOnTransientFsError(
        async () => {
          calls++;
          throw fsError("ENOENT");
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("backs off further on each attempt", async () => {
    const waits: number[] = [];
    let calls = 0;
    await retryOnTransientFsError(
      async () => {
        calls++;
        if (calls < 4) throw fsError("EBUSY");
        return undefined;
      },
      {
        delayMs: 10,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(waits).toEqual([10, 20, 30]);
  });
});
