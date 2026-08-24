import { describe, expect, it } from "vitest";
import {
  backoffMs,
  classifyFailure,
  isTransientFailure,
  MAX_BACKOFF_MS,
} from "./transientFailure";

describe("classifyFailure", () => {
  it("reads the failure that started all this as the transport's", () => {
    // Verbatim, from a correction run that was discarded for it.
    expect(
      classifyFailure(
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary — " +
          "try again in a moment. If it persists, check https://status.claude.com.",
      ),
    ).toBe("infrastructure");
  });

  it.each([
    "API Error: 503 Service Unavailable",
    "502 Bad Gateway",
    "upstream connect error",
    "read ECONNRESET",
    "fetch failed",
    "API Error: 429 rate limit exceeded",
  ])("blames the transport for %s", (reason) => {
    expect(isTransientFailure(reason)).toBe(true);
  });

  it.each([
    // The CLI's own limits are the stage's problem: retrying reaches the same wall.
    "error_max_turns",
    "timed out after 15 minute(s)",
    "asked 2 question(s) that were never answered",
    "required MCP server jira is unavailable",
    "session stopped — exit code 1",
  ])("blames the stage for %s", (reason) => {
    expect(classifyFailure(reason)).toBe("stage");
  });

  it("does not retry a limit no backoff reaches the other side of", () => {
    // Wears 429's clothes, and a retry would spend the budget discovering that
    // and then report the wrong reason.
    expect(classifyFailure("Claude usage limit reached (429). Resets at 3pm.")).toBe(
      "stage",
    );
    expect(classifyFailure("429: your credit balance is too low")).toBe("stage");
    expect(classifyFailure("API Error: 401 Unauthorized")).toBe("stage");
  });

  it("treats an unrecognised reason as the stage's, so nothing changes by accident", () => {
    expect(classifyFailure("the agent reported an error")).toBe("stage");
    expect(classifyFailure(undefined)).toBe("stage");
    expect(classifyFailure("   ")).toBe("stage");
  });

  it("does not read a stage's own prose about an overloaded database as transport", () => {
    // This reads the CLI's account of the failure, never the agent's report — but the
    // vocabulary is kept narrow enough that the distinction does not depend on it.
    expect(classifyFailure("the sql server was busy")).toBe("stage");
  });
});

describe("backoffMs", () => {
  it("grows, and is capped", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(20_000);
    expect(backoffMs(2, mid)).toBe(80_000);
    expect(backoffMs(5, mid)).toBe(MAX_BACKOFF_MS);
  });

  it("jitters, so tasks failing on one overload do not retry in lockstep", () => {
    expect(backoffMs(1, () => 0)).toBe(16_000);
    expect(backoffMs(1, () => 1)).toBe(24_000);
  });
});
