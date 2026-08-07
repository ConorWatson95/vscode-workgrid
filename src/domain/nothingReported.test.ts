import { describe, expect, it } from "vitest";
import { isNothingReported } from "./nothingReported";

describe("isNothingReported", () => {
  it("reads a section answered with nothing", () => {
    // Both real cases: a review filling in its Important section with "none", and a
    // stage answering the deferral question rather than omitting the line. Counted,
    // the first blocked a review and the second held a deployment — a stage saying
    // everything was fine stopping the route.
    for (const text of [
      "none",
      "None.",
      "- none",
      "nothing",
      "n/a",
      "N/A",
      "not applicable",
      "no findings",
      "no issues",
      "no deferrals",
      "none — this is Nissan GB only, so no second-manufacturer checks are needed",
    ]) {
      expect(isNothingReported(text), text).toBe(true);
    }
  });

  it("reads a section answered with the problem already dealt with", () => {
    // Seen under a **Critical** heading, which then blocked the route: the reviewer
    // was reporting that the critical issue was gone.
    for (const text of [
      "resolved",
      "- resolved",
      "Fixed.",
      "addressed by widening the column",
      "resolved in the migration",
      "accepted with reasoning recorded",
      "already fixed",
      "noted — this is the established access shape",
    ]) {
      expect(isNothingReported(text), text).toBe(true);
    }
  });

  it("leaves a settled word used as an adjective", () => {
    // "fixed" is the dangerous one: it describes columns as often as outcomes.
    for (const text of [
      "fixed width column overflows on export",
      "closed periods are still editable",
      "done flag is never cleared",
    ]) {
      expect(isNothingReported(text), text).toBe(false);
    }
  });

  it("leaves a real item that opens with the same word", () => {
    // The opposite error, and the worse one: silently dropping a genuine finding.
    for (const text of [
      "none of the migrations carry an explicit USE statement",
      "nothing in the rollback restores the deleted rows",
      "none of these are covered by the runtime QA plan",
      "no rollback exists for 002",
      "nonexistent column referenced in the join",
    ]) {
      expect(isNothingReported(text), text).toBe(false);
    }
  });
});
