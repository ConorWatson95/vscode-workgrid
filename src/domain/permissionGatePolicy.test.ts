import { describe, expect, it } from "vitest";
import {
  gateVerdict,
  nextAnnouncements,
  GatePolicyState,
  StandingApproval,
} from "./permissionGatePolicy";

const state = (overrides: Partial<GatePolicyState> = {}): GatePolicyState => ({
  refused: new Set(),
  approvals: new Map(),
  ...overrides,
});

const approvals = (entries: Record<string, StandingApproval>) =>
  new Map(Object.entries(entries));

describe("gateVerdict", () => {
  it("passes an unknown call so the CLI's own classifier decides", () => {
    // The reason a gate on every tool call is tolerable: a safe read is not held,
    // and we do not pretend to know the CLI's policy.
    expect(gateVerdict(state(), "Bash:git")).toEqual({ kind: "pass" });
  });

  it("holds a call the CLI already refused in this task", () => {
    expect(
      gateVerdict(state({ refused: new Set(["Bash:pwsh"]) }), "Bash:pwsh"),
    ).toEqual({ kind: "hold" });
  });

  it("answers from a session approval without asking again", () => {
    const verdict = gateVerdict(
      state({ approvals: approvals({ "Bash:pwsh": { scope: "session" } }) }),
      "Bash:pwsh",
    );
    expect(verdict).toMatchObject({ kind: "answer", decision: "allow" });
  });

  it("still holds a refused capability when nothing standing covers it", () => {
    // "Approve once" is satisfied by answering the waiting call itself and is
    // never stored, so the next attempt at the same capability asks again.
    expect(
      gateVerdict(state({ refused: new Set(["Bash:pwsh"]) }), "Bash:pwsh"),
    ).toEqual({ kind: "hold" });
  });

  it("denies from a standing denial rather than asking in a loop", () => {
    // Without this, refusing a call the agent keeps retrying would put the same
    // question in front of the user on every attempt.
    const verdict = gateVerdict(
      state({
        refused: new Set(["Bash:curl"]),
        approvals: approvals({ "Bash:curl": { scope: "session", deny: true } }),
      }),
      "Bash:curl",
    );
    expect(verdict).toMatchObject({ kind: "answer", decision: "deny" });
  });

  it("lets a standing approval beat a recorded refusal", () => {
    const verdict = gateVerdict(
      state({
        refused: new Set(["Bash:pwsh"]),
        approvals: approvals({ "Bash:pwsh": { scope: "always" } }),
      }),
      "Bash:pwsh",
    );
    expect(verdict).toMatchObject({ kind: "answer", decision: "allow" });
  });

  it("holds everything when the user asked for that", () => {
    expect(gateVerdict(state({ holdEverything: true }), "Bash:git")).toEqual({
      kind: "hold",
    });
  });

  it("still answers standing approvals when holding everything", () => {
    // Otherwise the strict mode would ask about the same capability forever.
    const verdict = gateVerdict(
      state({
        holdEverything: true,
        approvals: approvals({ "Bash:git": { scope: "session" } }),
      }),
      "Bash:git",
    );
    expect(verdict).toMatchObject({ kind: "answer", decision: "allow" });
  });

  it("gives a reason naming the scope, so the agent's transcript explains itself", () => {
    const verdict = gateVerdict(
      state({ approvals: approvals({ "Bash:pwsh": { scope: "always" } }) }),
      "Bash:pwsh",
    );
    expect(verdict).toMatchObject({ kind: "answer" });
    if (verdict.kind === "answer") expect(verdict.reason).toContain("rule");
  });
});

describe("nextAnnouncements", () => {
  it("announces a newly held call", () => {
    expect(nextAnnouncements(new Set(), ["r1"]).announce).toEqual(["r1"]);
  });

  it("does not announce the same call twice", () => {
    const first = nextAnnouncements(new Set(), ["r1"]);
    expect(nextAnnouncements(first.remember, ["r1"]).announce).toEqual([]);
  });

  it("announces a second call while the first is still waiting", () => {
    const first = nextAnnouncements(new Set(), ["r1"]);
    expect(nextAnnouncements(first.remember, ["r1", "r2"]).announce).toEqual(["r2"]);
  });

  it("forgets a call once it stops waiting, so the set stays bounded", () => {
    const first = nextAnnouncements(new Set(), ["r1", "r2"]);
    expect(nextAnnouncements(first.remember, ["r2"]).remember).toEqual(new Set(["r2"]));
  });

  it("announces every call when several are held at once", () => {
    // Parallel tool calls in one turn each get their own hook, so more than one
    // can be blocked simultaneously.
    expect(nextAnnouncements(new Set(), ["r1", "r2", "r3"]).announce).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("announces nothing when nothing is waiting", () => {
    const { announce, remember } = nextAnnouncements(new Set(["r1"]), []);
    expect(announce).toEqual([]);
    expect(remember.size).toBe(0);
  });

  it("does not mutate the set it was given", () => {
    const announced = new Set(["r1"]);
    nextAnnouncements(announced, ["r2"]);
    expect(announced).toEqual(new Set(["r1"]));
  });
});
