import { describe, expect, it } from "vitest";
import {
  MAX_PLAUSIBLE_CHANGED_PATHS,
  implausibleChangeSet,
} from "./changedPathSanity";

const paths = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);

describe("implausibleChangeSet", () => {
  it("accepts a change of the size a task actually is", () => {
    expect(implausibleChangeSet(paths(12), "DEV")).toBeUndefined();
  });

  it("accepts a large but believable change", () => {
    // A missed review is worse than a slow one, so this must only fire on the
    // obviously absurd — a few hundred files is a big refactor, not an error.
    expect(implausibleChangeSet(paths(MAX_PLAUSIBLE_CHANGED_PATHS), "DEV")).toBeUndefined();
  });

  it("rejects a set the size of a branch lineage", () => {
    // The real incident: 9,569 paths, which matched all eight of a project's rules
    // and queued four unrelated reviews onto a one-line change.
    const result = implausibleChangeSet(paths(9569), "DEV");
    expect(result?.count).toBe(9569);
    expect(result?.limit).toBe(MAX_PLAUSIBLE_CHANGED_PATHS);
  });

  it("names the base branch, being the input most likely at fault", () => {
    const result = implausibleChangeSet(paths(9569), "DEV");
    expect(result?.message).toContain('"DEV"');
    // Says what it did about it, not only what it saw.
    expect(result?.message).toContain("not being applied");
  });

  it("fires one path above the limit, not at it", () => {
    expect(implausibleChangeSet(paths(MAX_PLAUSIBLE_CHANGED_PATHS + 1), "DEV")).toBeDefined();
  });
});
