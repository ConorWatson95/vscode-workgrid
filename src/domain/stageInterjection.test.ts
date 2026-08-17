import { describe, expect, it } from "vitest";
import {
  INTERJECTION_MARKER,
  interjectionDenialReason,
  isDeliverableInterjection,
} from "./stageInterjection";

describe("isDeliverableInterjection", () => {
  it("accepts a real message", () => {
    expect(isDeliverableInterjection("count directories, not files")).toBe(true);
  });

  it("refuses an empty or whitespace-only message", () => {
    // Delivering one would refuse a tool call in order to say nothing.
    expect(isDeliverableInterjection("")).toBe(false);
    expect(isDeliverableInterjection("   \n ")).toBe(false);
  });
});

describe("interjectionDenialReason", () => {
  const reason = interjectionDenialReason("  Use tab 3 of the wireframe, not Phase 2.  ");

  it("opens with the marker the preamble declared", () => {
    // The provenance the session actually checks. Measured twice on CLI 2.1.223: an
    // undeclared instruction arriving in a tool channel is refused as untrusted
    // content, and correctly so. If the message and the declaration ever drift, the
    // feature silently reverts to being ignored.
    expect(reason.startsWith(INTERJECTION_MARKER)).toBe(true);
  });

  it("carries the operator's message", () => {
    expect(reason).toContain("Use tab 3 of the wireframe, not Phase 2.");
  });

  it("names the sender, so the agent does not read it as an injected string", () => {
    // Probed: given an anonymous instruction inside a denial, a session declined to
    // act on it and answered the original request instead — correctly, and uselessly.
    expect(reason).toMatch(/operator/i);
    expect(reason).toMatch(/harness/i);
    expect(reason).toMatch(/not a tool result/i);
  });

  it("says the held call did not run and nothing is wrong", () => {
    // Otherwise a denial reads as a permission wall, and the agent starts working
    // around it — the behaviour the gate exists to prevent.
    expect(reason).toMatch(/was not run/i);
    expect(reason).toMatch(/nothing\s+has gone wrong/i);
  });

  it("states that it outranks the brief and the current plan", () => {
    expect(reason).toMatch(/outranks your brief/i);
  });

  it("leaves re-issuing the held call to the stage's judgement", () => {
    expect(reason).toMatch(/re-issuing the held call if it is still the right next step/i);
  });

  it("asks the stage to report what it was told and what changed", () => {
    expect(reason).toMatch(/report what you were asked/i);
  });
});
