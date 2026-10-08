import { describe, expect, it } from "vitest";
import {
  isNotReadyHold,
  notReadyHoldReason,
  parseNotReady,
} from "./environmentReadiness";

describe("parseNotReady", () => {
  it("reads the reason a check gave for not running", () => {
    expect(
      parseNotReady("Checking DEV…\nNOT-READY: DEV is serving 28fb76b29, which predates this branch\n"),
    ).toBe("DEV is serving 28fb76b29, which predates this branch");
  });

  it("takes the last such line", () => {
    expect(parseNotReady("NOT-READY: first\nNOT-READY: second")).toBe("second");
  });

  it("ignores the word anywhere but the start of a line", () => {
    // A check failing because a page says "NOT-READY" must not be read as a wait.
    expect(parseNotReady('body contains "status: NOT-READY: queued"')).toBeUndefined();
  });

  it("is undefined for ordinary output and an empty reason", () => {
    expect(parseNotReady("4 passed (41.4s)")).toBeUndefined();
    expect(parseNotReady("NOT-READY:   ")).toBeUndefined();
  });
});

describe("notReadyHoldReason", () => {
  it("is recognised as its own hold, and names the remedy", () => {
    const reason = notReadyHoldReason("DEV is serving an older build", 20);
    expect(reason).toContain("still not ready after 20 minutes");
    expect(reason).toContain("Re-run Check");
    expect(isNotReadyHold(reason)).toBe(true);
    expect(isNotReadyHold("Verification failed (exit 1): x")).toBe(false);
  });

  it("does not claim a wait that did not happen", () => {
    expect(notReadyHoldReason("x", 0)).toContain("is not ready: x");
  });
});
