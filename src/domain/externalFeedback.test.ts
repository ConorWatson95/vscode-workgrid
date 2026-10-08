import { describe, expect, it } from "vitest";
import {
  feedbackCommandFor,
  hasUnreadFeedback,
  parseFeedbackOutput,
  summariseFeedback,
} from "./externalFeedback";

describe("parseFeedbackOutput", () => {
  it("reads a comments object, skipping log lines before it", () => {
    const parsed = parseFeedbackOutput(
      'Fetching NMGB-1...\n{"comments":[{"author":"Tess","created":"2026-10-08T09:00:00Z","body":"Still  wrong\\non export"}]}',
    );
    expect(parsed).toEqual({
      ok: true,
      comments: [{ author: "Tess", at: "2026-10-08T09:00:00Z", excerpt: "Still wrong on export" }],
    });
  });

  it("drops an undated entry rather than the whole reply", () => {
    const parsed = parseFeedbackOutput('[{"author":"A"},{"created":"2026-10-08T09:00:00Z"}]');
    expect(parsed.ok && parsed.comments.map((c) => c.author)).toEqual(["someone"]);
  });

  it("treats output that is not JSON as an error, not a quiet ticket", () => {
    expect(parseFeedbackOutput("401 Unauthorized").ok).toBe(false);
    expect(parseFeedbackOutput('{"issues":[]}').ok).toBe(false);
  });
});

describe("hasUnreadFeedback", () => {
  const wait = "2026-10-07T12:00:00Z";
  const comment = (at: string) => ({ author: "Tess", at, excerpt: "" });

  it("is true for a comment after the wait began", () => {
    expect(
      hasUnreadFeedback({ latest: comment("2026-10-08T09:00:00Z"), count: 1, checkedAt: "" }, wait),
    ).toBe(true);
  });

  it("ignores a comment from before this gate's wait", () => {
    expect(
      hasUnreadFeedback({ latest: comment("2026-10-06T09:00:00Z"), count: 1, checkedAt: "" }, wait),
    ).toBe(false);
  });

  it("is false once read, and true again for a later comment", () => {
    const read = { count: 1, checkedAt: "", readAt: "2026-10-08T10:00:00Z" };
    expect(hasUnreadFeedback({ ...read, latest: comment("2026-10-08T09:00:00Z") }, wait)).toBe(false);
    expect(hasUnreadFeedback({ ...read, latest: comment("2026-10-08T11:00:00Z") }, wait)).toBe(true);
  });

  it("is false with no wait in play", () => {
    expect(
      hasUnreadFeedback({ latest: comment("2026-10-08T09:00:00Z"), count: 1, checkedAt: "" }, undefined),
    ).toBe(false);
  });
});

describe("summariseFeedback", () => {
  it("keeps only comments after the cutoff, newest first", () => {
    const summary = summariseFeedback(
      [
        { author: "A", at: "2026-10-06T00:00:00Z", excerpt: "old" },
        { author: "B", at: "2026-10-08T09:00:00Z", excerpt: "mid" },
        { author: "C", at: "2026-10-08T10:00:00Z", excerpt: "new" },
      ],
      "2026-10-07T00:00:00Z",
      "2026-10-08T11:00:00Z",
      undefined,
    );
    expect(summary.count).toBe(2);
    expect(summary.latest?.author).toBe("C");
  });
});

describe("feedbackCommandFor", () => {
  it("substitutes ref and since", () => {
    expect(feedbackCommandFor("x -Key ${ref} -Since ${since}", "NMGB-12", "2026-10-08T09:00:00.000Z")).toEqual({
      ok: true,
      command: "x -Key NMGB-12 -Since 2026-10-08T09:00:00.000Z",
    });
  });

  it("refuses a ref that could break out of the command line", () => {
    expect(feedbackCommandFor("x ${ref}", "A; rm -rf /", "2026-10-08T09:00:00Z").ok).toBe(false);
  });
});
