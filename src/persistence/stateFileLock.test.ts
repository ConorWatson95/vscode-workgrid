import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCK_POLICY,
  isBreakable,
  lockPathFor,
  parseLockRecord,
} from "./stateFileLock";

const NOW = "2026-08-20T13:00:00.000Z";
const OWNER = "1234-0";

function breakable(record: Parameters<typeof isBreakable>[0]): boolean {
  return isBreakable(record, { now: NOW, owner: OWNER, policy: DEFAULT_LOCK_POLICY });
}

describe("parseLockRecord", () => {
  it("reads a well-formed record", () => {
    expect(parseLockRecord(JSON.stringify({ owner: "7-0", at: NOW }))).toEqual({
      owner: "7-0",
      at: NOW,
    });
  });

  // A process killed mid-acquire leaves exactly this, and reading it as a valid
  // hold would wedge the file until somebody deleted it by hand.
  it.each([
    ["absent", undefined],
    ["not json", "{ half-writ"],
    ["not an object", "42"],
    ["a missing owner", JSON.stringify({ at: NOW })],
    ["a non-string owner", JSON.stringify({ owner: 7, at: NOW })],
    ["an unparseable time", JSON.stringify({ owner: "7-0", at: "soon" })],
  ])("returns undefined for %s", (_label, contents) => {
    expect(parseLockRecord(contents as string | undefined)).toBeUndefined();
  });
});

describe("isBreakable", () => {
  it("breaks a lock with no readable holder", () => {
    expect(breakable(undefined)).toBe(true);
  });

  // Only reachable when a release failed. Waiting would be a deadlock against
  // ourselves, since the thing that would release it is the caller. Keyed on the
  // instance, not the process: two locks on one file in one host would otherwise
  // each read the other's hold as their own.
  it("breaks our own lock", () => {
    expect(breakable({ owner: OWNER, at: NOW })).toBe(true);
  });

  it("waits for a fresh lock held by someone else", () => {
    expect(breakable({ owner: "99-0", at: "2026-08-20T12:59:59.000Z" })).toBe(false);
  });

  it("breaks one older than the stale threshold", () => {
    expect(breakable({ owner: "99-0", at: "2026-08-20T12:59:49.000Z" })).toBe(true);
  });

  // Two machines sharing a checkout disagree about the time. Read as fresh, a
  // future-stamped lock waits out the whole give-up window on every write.
  it("breaks one stamped in the future", () => {
    expect(breakable({ owner: "99-0", at: "2026-08-20T13:05:00.000Z" })).toBe(true);
  });
});

describe("lockPathFor", () => {
  it("sits beside the file it guards", () => {
    expect(lockPathFor("/repo/.git/task-workspaces/state.json")).toBe(
      "/repo/.git/task-workspaces/state.json.lock",
    );
  });
});
