import { describe, expect, it } from "vitest";
import {
  MCP_STARTUP_TIMEOUT_VAR,
  MCP_TOOL_TIMEOUT_VAR,
  askTimeoutEnv,
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

  it("clamps a zero, negative or non-finite wait rather than passing it through", () => {
    for (const value of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(askTimeoutEnv(value)[MCP_TOOL_TIMEOUT_VAR]).toBe("60000");
    }
  });
});
