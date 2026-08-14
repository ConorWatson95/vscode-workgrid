import { describe, expect, it } from "vitest";
import {
  buildLookupPrompt,
  NOT_FOUND_MARKER,
  parseLookupReply,
} from "./suggestionLookup";
import { SuggestionSource } from "./suggestionSourceFile";

const SOURCE: SuggestionSource = {
  id: "jira",
  label: "JIRA",
  scanPrompt: "List every open ticket assigned to me in the NMGB project.",
  order: { ranks: ["Blocker", "Major"] },
};

describe("buildLookupPrompt", () => {
  it("overrides the scan prompt's idea of which items count", () => {
    // The whole reason a lookup exists: a scan lists what is outstanding, and the ticket
    // a task already under way is for is normally in progress or closed.
    const prompt = buildLookupPrompt(SOURCE, "NMGB-2534");
    expect(prompt).toContain(SOURCE.scanPrompt);
    expect(prompt).toContain("IGNORE the instruction above");
    expect(prompt).toMatch(/closed, in progress/);
  });

  it("asks for the system's own spelling, which is what makes the echo check mean anything", () => {
    const prompt = buildLookupPrompt(SOURCE, "nmgb-2534");
    expect(prompt).toContain("own identifier");
    expect(prompt).toContain(NOT_FOUND_MARKER);
  });

  it("says the lookup changes nothing", () => {
    expect(buildLookupPrompt(SOURCE, "NMGB-2534")).toContain("read-only");
  });
});

describe("parseLookupReply", () => {
  it("reads a found item, keeping the source's spelling and its link", () => {
    const reply = [
      "SUGGESTION: NMGB-2534 | In Progress | Nissan GB Data Load - Rescura",
      "URL: https://jira.example/browse/NMGB-2534",
    ].join("\n");

    const outcome = parseLookupReply(reply, "jira", "nmgb-2534");
    expect(outcome).toEqual({
      kind: "found",
      suggestion: {
        sourceId: "jira",
        ref: "NMGB-2534",
        title: "Nissan GB Data Load - Rescura",
        rank: "In Progress",
        url: "https://jira.example/browse/NMGB-2534",
      },
    });
  });

  it("reads the not-found marker", () => {
    expect(parseLookupReply("NOT-FOUND", "jira", "NMGB-9999")).toEqual({ kind: "notFound" });
  });

  it("reads the marker inside a sentence, since a model rarely answers with one word", () => {
    const outcome = parseLookupReply(
      "I searched the NMGB project and there is no such issue. NOT-FOUND",
      "jira",
      "NMGB-9999",
    );
    expect(outcome).toEqual({ kind: "notFound" });
  });

  it("refuses an item reported under a different ref", () => {
    // A session answering about the wrong item. Recording it would attach the task to a
    // ticket nobody asked about, and scope its promotion check to that one's commits.
    const outcome = parseLookupReply(
      "SUGGESTION: NMGB-2792 | Done | EV share",
      "jira",
      "NMGB-2534",
    );
    expect(outcome.kind).toBe("unreadable");
  });

  it("tells an unreadable reply from a missing ticket", () => {
    // Opposite remedies: one means fix the ref, the other means the lookup did not work.
    // Reported as notFound, this would tell somebody their real ticket does not exist.
    const outcome = parseLookupReply("I was unable to reach the board.", "jira", "NMGB-2534");
    expect(outcome).toEqual({
      kind: "unreadable",
      reply: "I was unable to reach the board.",
    });
  });

  it("accepts the ref however its punctuation is written", () => {
    const outcome = parseLookupReply(
      "SUGGESTION: NMGB-2534 | Closed | Rescura",
      "jira",
      "#nmgb 2534",
    );
    expect(outcome.kind).toBe("found");
  });

  it("does not read a stage saying nothing as a found item", () => {
    // `isNothingReported`'s fourth caller. A reply of "none" is a report of nothing.
    const outcome = parseLookupReply(
      "SUGGESTION: NMGB-2534 | none",
      "jira",
      "NMGB-2534",
    );
    expect(outcome.kind).toBe("unreadable");
  });
});
