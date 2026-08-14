import { describe, expect, it } from "vitest";
import { findTicketReference, taskTicket } from "./ticketReference";

describe("findTicketReference", () => {
  it("finds a reference in a commit subject", () => {
    expect(
      findTicketReference(
        "https://qubedatainnovation.atlassian.net/browse/NMGB-2534 - QubeAutoApp - Docs",
      ),
    ).toBe("NMGB-2534");
  });

  it("finds nothing in a name that carries none", () => {
    // The real failure: this task's UAT promotion exited 4 while every commit on its
    // branch said NMGB-2534.
    expect(findTicketReference("Nissan GB - Data Load - Rescura")).toBeUndefined();
  });

  it("does not match lower case, which the script would refuse", () => {
    // The harness calling something a ticket that the script then rejects fails the
    // check with a message about the wrong thing.
    expect(findTicketReference("nmgb-2534")).toBeUndefined();
  });

  it("takes the first of several", () => {
    expect(findTicketReference("RU-550 supersedes NMGB-2534")).toBe("RU-550");
  });
});

describe("taskTicket", () => {
  it("prefers what the task was linked to", () => {
    // The link was chosen deliberately; a name was not.
    expect(
      taskTicket({ name: "NMGB-1 old name", origin: { ref: "NMGB-2534" } }),
    ).toBe("NMGB-2534");
  });

  it("falls back to the task name, so routes passing ${taskName} keep working", () => {
    expect(taskTicket({ name: "NMGB-2792 Brake discs" })).toBe("NMGB-2792");
  });

  it("is undefined when nothing establishes one", () => {
    expect(taskTicket({ name: "Nissan GB - Data Load - Rescura" })).toBeUndefined();
  });

  it("reads a ref that is bare rather than a URL", () => {
    expect(taskTicket({ name: "Rescura", origin: { ref: "NMGB-2534" } })).toBe("NMGB-2534");
  });
});
