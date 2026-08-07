import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_SUBAGENTS_VAR,
  MAX_SUBAGENT_SPAWN_DEPTH_VAR,
  subagentLimitEnv,
} from "./subagentLimits";

describe("subagentLimitEnv", () => {
  it("names both CLI variables as strings", () => {
    expect(subagentLimitEnv({ concurrency: 3, depth: 1 })).toEqual({
      [MAX_CONCURRENT_SUBAGENTS_VAR]: "3",
      [MAX_SUBAGENT_SPAWN_DEPTH_VAR]: "1",
    });
  });

  // Zero would reach the CLI as a limit it may treat as unset — the opposite of
  // what someone setting zero meant, and invisible once the run is under way.
  it("clamps zero and negatives to one rather than passing them through", () => {
    const env = subagentLimitEnv({ concurrency: 0, depth: -4 });
    expect(env[MAX_CONCURRENT_SUBAGENTS_VAR]).toBe("1");
    expect(env[MAX_SUBAGENT_SPAWN_DEPTH_VAR]).toBe("1");
  });

  it("floors fractions and survives a non-finite value", () => {
    const env = subagentLimitEnv({ concurrency: 2.9, depth: Number.NaN });
    expect(env[MAX_CONCURRENT_SUBAGENTS_VAR]).toBe("2");
    expect(env[MAX_SUBAGENT_SPAWN_DEPTH_VAR]).toBe("1");
  });
});
