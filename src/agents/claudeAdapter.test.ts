import { describe, expect, it } from "vitest";
import { invariantProtocolBlock } from "./claudeAdapter";

describe("invariantProtocolBlock", () => {
  // The whole reason this block is separated out. Prompt caching matches on a
  // prefix, so anything varying inside it makes every stage of every task
  // uncacheable — across the dozen sessions a route spawns, that is the
  // difference between paying for the preamble once and paying for it twelve
  // times. A test rather than a comment because the failure is invisible: the
  // prompts still work, they just stop being reused.
  it("is identical between calls, so it can be a cached prefix", () => {
    const first = invariantProtocolBlock({ needsInfo: "NEEDS-INFO:" }).join("\n");
    const second = invariantProtocolBlock({ needsInfo: "NEEDS-INFO:" }).join("\n");
    expect(first).toBe(second);
  });

  it("interpolates nothing but the markers it is given", () => {
    const block = invariantProtocolBlock({ needsInfo: "MARKER-X:" }).join("\n");
    expect(block).toContain("MARKER-X:");
    // No task, branch, stage or path may appear: those vary per run and belong
    // after this block.
    expect(block).not.toMatch(/\$\{/);
  });

  it("states the contract the parsers depend on rather than assuming a skill loaded", () => {
    const block = invariantProtocolBlock({ needsInfo: "NEEDS-INFO:" }).join("\n");
    expect(block).toContain("ask_user");
    expect(block).toContain("NEEDS-INFO:");
  });
});
