import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_SUBAGENTS_VAR,
  MAX_SUBAGENT_SPAWN_DEPTH_VAR,
  SUBAGENT_MODEL_FORCE_VAR,
  subagentLimitEnv,
} from "./subagentLimits";

describe("subagentLimitEnv", () => {
  // Exhaustive on purpose: this is the whole environment a stage process is given for
  // subagents, and a variable added without a decision behind it should fail here.
  it("names every CLI variable as a string", () => {
    expect(subagentLimitEnv({ concurrency: 3, depth: 1 })).toEqual({
      [MAX_CONCURRENT_SUBAGENTS_VAR]: "3",
      [MAX_SUBAGENT_SPAWN_DEPTH_VAR]: "1",
      [SUBAGENT_MODEL_FORCE_VAR]: "1",
    });
  });

  // A stage's declared model is a statement about how that work gets done, and 7% of
  // stage sessions delegate. Without the force, a delegated run could take its model
  // from an agent definition the harness never reads.
  it("forces subagents onto the stage's model whatever the limits are", () => {
    for (const limits of [{ concurrency: 1, depth: 1 }, { concurrency: 8, depth: 3 }]) {
      expect(subagentLimitEnv(limits)[SUBAGENT_MODEL_FORCE_VAR]).toBe("1");
    }
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
