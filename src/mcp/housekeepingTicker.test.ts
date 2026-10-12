import { describe, expect, it } from "vitest";
import { HousekeepingTicker } from "./housekeepingTicker";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe("HousekeepingTicker", () => {
  it("does not start a second tick while one is still launching", async () => {
    let release!: () => void;
    let launches = 0;
    const ticker = new HousekeepingTicker(
      () => (launches++, new Promise<void>((resolve) => (release = resolve))),
      quiet,
    );
    const first = ticker.tickNow();
    expect(await ticker.tickNow()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(launches).toBe(1);
  });

  it("reports a failed launch without throwing, and can launch again after it", async () => {
    let fail = true;
    const ticker = new HousekeepingTicker(async () => {
      if (fail) throw new Error("no node");
    }, quiet);
    expect(await ticker.tickNow()).toBe(false);
    fail = false;
    expect(await ticker.tickNow()).toBe(true);
  });
});
