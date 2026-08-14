import { describe, expect, it } from "vitest";
import { findTicketReference, isTicketReference, taskTicket } from "./ticketReference";

describe("isTicketReference", () => {
  it("accepts a bare reference", () => {
    expect(isTicketReference("NMGB-2534")).toBe(true);
    expect(isTicketReference("  NMGB-2534  ")).toBe(true);
  });

  it("refuses a reference buried in prose", () => {
    // Anchored where findTicketReference is not: searching a task name for a reference is
    // right because the rest is prose, but a box asking for a ticket must not accept
    // "the one about NMGB-2534 maybe" and link the task to something not quite said.
    expect(isTicketReference("the one about NMGB-2534 maybe")).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(isTicketReference("   ")).toBe(false);
  });

  it("uses the source's own shape when it declares one", () => {
    // A ref is opaque to the runtime everywhere else, so a source keyed on numbers would
    // otherwise have every one of its real refs refused.
    expect(isTicketReference("4821", "[0-9]+")).toBe(true);
    expect(isTicketReference("NMGB-2534", "[0-9]+")).toBe(false);
  });

  it("matches the whole ref, so a pattern need not anchor itself", () => {
    expect(isTicketReference("12345x", "[0-9]+")).toBe(false);
  });

  it("accepts anything when the source's pattern does not compile", () => {
    // Parsing rejects these, so reaching here means the check is broken — and refusing
    // every ref because the runtime cannot read its own config blocks work over a config
    // error the typist did not make and cannot see from the box they are standing in.
    expect(isTicketReference("anything at all", "([unclosed")).toBe(true);
  });
});

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
