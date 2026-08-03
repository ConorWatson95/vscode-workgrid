import { describe, it, expect } from "vitest";
import {
  taskStatusPresentation,
  agentControls,
  buildContextValue,
  deriveAgentActivity,
  agentActivityPresentation,
} from "./statusPresentation";

describe("deriveAgentActivity", () => {
  it("maps running to working", () => {
    expect(deriveAgentActivity("running", true)).toBe("working");
  });
  it("maps a completed turn (waiting, not busy) to input-required", () => {
    expect(deriveAgentActivity("waiting", false)).toBe("input-required");
  });
  it("treats a busy waiting state as still working", () => {
    expect(deriveAgentActivity("waiting", true)).toBe("working");
  });
  it("maps stopped/completed to finished and failed to failed", () => {
    expect(deriveAgentActivity("stopped", false)).toBe("finished");
    expect(deriveAgentActivity("completed", false)).toBe("finished");
    expect(deriveAgentActivity("failed", false)).toBe("failed");
  });
  it("returns undefined when there is no session", () => {
    expect(deriveAgentActivity(undefined, false)).toBeUndefined();
  });
});

describe("agentActivityPresentation", () => {
  it("colour-codes each activity distinctly", () => {
    expect(agentActivityPresentation("working").colorId).toBe("charts.blue");
    expect(agentActivityPresentation("input-required").colorId).toBe("charts.yellow");
    expect(agentActivityPresentation("finished").colorId).toBe("charts.green");
    expect(agentActivityPresentation("failed").colorId).toBe("charts.red");
  });
});

describe("taskStatusPresentation", () => {
  it("maps known statuses to icons", () => {
    expect(taskStatusPresentation("implementing").iconId).toBe("play-circle");
    expect(taskStatusPresentation("failed").iconId).toBe("error");
    expect(taskStatusPresentation("archived").iconId).toBe("archive");
  });
});

describe("agentControls", () => {
  it("allows starting when no agent or stopped", () => {
    expect(agentControls(undefined)).toEqual({ startable: true, stoppable: false });
    expect(agentControls("stopped")).toEqual({ startable: true, stoppable: false });
  });

  it("allows stopping when running", () => {
    expect(agentControls("running")).toEqual({ startable: false, stoppable: true });
    expect(agentControls("waiting")).toEqual({ startable: false, stoppable: true });
  });
});

describe("buildContextValue harness token", () => {
  it("marks a harnessed task so the row can offer one action", () => {
    expect(buildContextValue("ready", undefined, true)).toContain("harnessed");
  });

  it("uses a token that cannot substring-match the other", () => {
    // Menu `when` clauses match contextValue by substring, so /harnessed/ must not
    // also match an unharnessed task.
    const adhoc = buildContextValue("ready", undefined, false);
    expect(adhoc).toContain("adhoc");
    expect(adhoc).not.toContain("harnessed");
  });

  it("defaults to ad-hoc when not specified", () => {
    expect(buildContextValue("ready", undefined)).toContain("adhoc");
  });
});

describe("buildContextValue", () => {
  it("marks a ready task as agent-startable", () => {
    expect(buildContextValue("ready", undefined)).toContain("agentStartable");
  });

  it("marks a running-agent task as agent-stoppable", () => {
    const value = buildContextValue("implementing", "running");
    expect(value).toContain("agentStoppable");
    expect(value).not.toContain("agentStartable");
  });

  it("never offers to start an agent on an archived task", () => {
    expect(buildContextValue("archived", undefined)).not.toContain("agentStartable");
  });
});
