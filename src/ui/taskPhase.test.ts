import { describe, it, expect } from "vitest";
import { deriveTaskPhase, taskPhasePresentation } from "./taskPhase";

describe("deriveTaskPhase", () => {
  it("is planning when the agent works with no changes yet", () => {
    expect(deriveTaskPhase({ activity: "working", dirty: false, commitsAhead: 0 })).toBe("planning");
  });
  it("is implementing when the agent works with uncommitted changes", () => {
    expect(deriveTaskPhase({ activity: "working", dirty: true, commitsAhead: 0 })).toBe("implementing");
  });
  it("is needs-input when the agent is awaiting the user", () => {
    expect(deriveTaskPhase({ activity: "input-required", dirty: true, commitsAhead: 0 })).toBe("needs-input");
  });
  it("reflects uncommitted changes at rest", () => {
    expect(deriveTaskPhase({ activity: undefined, dirty: true, commitsAhead: 0 })).toBe("changes-uncommitted");
  });
  it("is committed when work is committed ahead of base and tree is clean", () => {
    expect(deriveTaskPhase({ activity: undefined, dirty: false, commitsAhead: 2 })).toBe("committed");
  });
  it("is ready when nothing has happened", () => {
    expect(deriveTaskPhase({ activity: undefined, dirty: false, commitsAhead: 0 })).toBe("ready");
  });
});

describe("taskPhasePresentation", () => {
  it("colour-codes the lifecycle distinctly", () => {
    expect(taskPhasePresentation("planning").colorId).toBe("charts.purple");
    expect(taskPhasePresentation("implementing").colorId).toBe("charts.blue");
    expect(taskPhasePresentation("needs-input").colorId).toBe("charts.yellow");
    expect(taskPhasePresentation("changes-uncommitted").colorId).toBe("charts.orange");
    expect(taskPhasePresentation("committed").colorId).toBe("charts.green");
    expect(taskPhasePresentation("ready").colorId).toBeUndefined();
  });
});
