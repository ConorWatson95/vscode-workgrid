import { describe, expect, it } from "vitest";
import {
  INDEFINITE_TIMEOUT_MS,
  MCP_STARTUP_TIMEOUT_VAR,
  MCP_TOOL_TIMEOUT_VAR,
  askTimeoutEnv,
  askTimeoutMs,
  isIndefinite,
} from "./askTimeout";

describe("askTimeoutEnv", () => {
  it("expresses the wait in milliseconds, which is what the CLI reads", () => {
    expect(askTimeoutEnv(120)[MCP_TOOL_TIMEOUT_VAR]).toBe("7200000");
  });

  // The failure this exists for: on the CLI's own default, a question left for a few
  // minutes fails as a timed-out tool call and the agent answers itself.
  it("allows a wait far longer than a person watching one task", () => {
    expect(Number(askTimeoutEnv(120)[MCP_TOOL_TIMEOUT_VAR])).toBeGreaterThan(60 * 60_000);
  });

  it("does not make startup wait as long as a person", () => {
    // A server that has not connected in a minute is broken, and `mcpReadiness` can
    // only abandon the stage cheaply if it finds that out before inference.
    expect(Number(askTimeoutEnv(120)[MCP_STARTUP_TIMEOUT_VAR])).toBeLessThanOrEqual(60_000);
  });

  it("clamps a fractional or non-finite wait rather than passing it through", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(askTimeoutEnv(value)[MCP_TOOL_TIMEOUT_VAR]).toBe("60000");
    }
    expect(askTimeoutEnv(0.4)[MCP_TOOL_TIMEOUT_VAR]).toBe("60000");
  });

  it("treats zero and below as no limit", () => {
    for (const value of [0, -10]) {
      expect(isIndefinite(value)).toBe(true);
      expect(askTimeoutMs(value)).toBe(INDEFINITE_TIMEOUT_MS);
    }
  });

  it("sets the variable even when unbounded, because absence means the CLI's default", () => {
    // The one thing "no limit" must never be spelled as. Omitting it restores the
    // short default and reproduces, silently, the failure this module exists to fix.
    const env = askTimeoutEnv(0);
    expect(env[MCP_TOOL_TIMEOUT_VAR]).toBe(String(INDEFINITE_TIMEOUT_MS));
    expect(Number(env[MCP_TOOL_TIMEOUT_VAR])).toBeGreaterThan(30 * 24 * 60 * 60_000);
  });

  it("keeps the unbounded value inside the range another program can parse", () => {
    // Stringified into an environment variable and read back as an integer elsewhere.
    // An overflow read as zero would expire every question the instant it was asked.
    expect(INDEFINITE_TIMEOUT_MS).toBeLessThan(Number.MAX_SAFE_INTEGER / 1000);
    expect(String(INDEFINITE_TIMEOUT_MS)).toMatch(/^\d+$/);
  });
});
