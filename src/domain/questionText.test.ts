import { describe, expect, it } from "vitest";
import { splitQuestion } from "./questionText";

describe("splitQuestion", () => {
  it("returns a one-sentence question unchanged, with no detail", () => {
    const split = splitQuestion("Should AR purchases fold into the franchise total?");
    expect(split.headline).toBe(
      "Should AR purchases fold into the franchise total?",
    );
    expect(split.detail).toBeUndefined();
  });

  it("promotes the question ahead of the background it arrived after", () => {
    const split = splitQuestion(
      "The scorecard proc aggregates at dealer grain. Every manufacturer shares it. " +
        "Should AR purchases fold into the franchise total?",
    );
    expect(split.headline).toBe(
      "Should AR purchases fold into the franchise total?",
    );
    expect(split.detail).toBe(
      "The scorecard proc aggregates at dealer grain. Every manufacturer shares it.",
    );
  });

  it("keeps trailing background as detail rather than dropping it", () => {
    const split = splitQuestion(
      "Which database should the migration target? I will then write the rollback.",
    );
    expect(split.headline).toBe("Which database should the migration target?");
    expect(split.detail).toBe("I will then write the rollback.");
  });

  it("prefers the last restatement when a question asks itself twice", () => {
    const split = splitQuestion(
      "Should this be scoped by tenant? Specifically, should the filter use TenantId?",
    );
    expect(split.headline).toBe(
      "Specifically, should the filter use TenantId?",
    );
  });

  it("leaves an imperative whole rather than promoting a guess", () => {
    const text =
      "The two candidates are DEV and UAT. Confirm which one the deploy targets.";
    expect(splitQuestion(text)).toEqual({ headline: text, detail: undefined });
  });

  it("does not split on an abbreviation or a version number", () => {
    const split = splitQuestion(
      "The proc targets SQL 2019. Should the migration use OPENJSON?",
    );
    expect(split.detail).toBe("The proc targets SQL 2019.");
  });

  it("collapses whitespace so a wrapped question is one line", () => {
    const split = splitQuestion("Should the\n  filter use\tTenantId?");
    expect(split.headline).toBe("Should the filter use TenantId?");
  });
});
