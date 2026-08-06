import { describe, expect, it } from "vitest";
import {
  parsePlanSteps,
  parseStepAccounts,
  planStepInstruction,
  stripStepAccounts,
  unaccountedSteps,
} from "./planSteps";

describe("parsePlanSteps", () => {
  it("reads numbered headings", () => {
    const steps = parsePlanSteps(
      [
        "# Deployment plan",
        "",
        "## 1. Ship the migration",
        "Some prose.",
        "",
        "## 2) Flip the flag",
        "",
        "### Step 3 — Post-deploy data rebuild",
      ].join("\n"),
    );

    expect(steps).toEqual([
      { number: 1, title: "Ship the migration" },
      { number: 2, title: "Flip the flag" },
      { number: 3, title: "Post-deploy data rebuild" },
    ]);
  });

  it("reads a top-level numbered list when there are no numbered headings", () => {
    const steps = parsePlanSteps(
      ["## Plan", "", "1. Ship the migration", "2. Rebuild the KPI elements"].join("\n"),
    );
    expect(steps.map((s) => s.number)).toEqual([1, 2]);
  });

  it("ignores numbered lists inside a plan that numbers its headings", () => {
    // The failure this prevents: a plan with four steps, each containing its own
    // numbered sub-list, would demand accounting for every sub-bullet.
    const steps = parsePlanSteps(
      ["## 1. Ship the migration", "1. run it", "2. check it", "", "## 2. Rebuild"].join("\n"),
    );
    expect(steps.map((s) => s.number)).toEqual([1, 2]);
    expect(steps[0].title).toBe("Ship the migration");
  });

  it("skips fenced code, so a quoted script is not read as steps", () => {
    const steps = parsePlanSteps(
      ["1. Ship it", "", "```sql", "1) not a step", "2) also not a step", "```", "2. Rebuild"].join(
        "\n",
      ),
    );
    expect(steps.map((s) => s.number)).toEqual([1, 2]);
  });

  it("ignores indented numbered items, which are sub-steps", () => {
    const steps = parsePlanSteps(["1. Ship it", "   1. sub-step", "2. Rebuild"].join("\n"));
    expect(steps.map((s) => s.number)).toEqual([1, 2]);
  });

  it("keeps the first occurrence of a repeated number", () => {
    const steps = parsePlanSteps(["## 1. First", "## 1. Restated"].join("\n"));
    expect(steps).toEqual([{ number: 1, title: "First" }]);
  });

  it("names a step with no title after its number", () => {
    expect(parsePlanSteps("## 4.")).toEqual([{ number: 4, title: "Step 4" }]);
  });

  it("returns nothing for a plan with no numbered steps", () => {
    expect(parsePlanSteps("Just some prose about deploying.")).toEqual([]);
  });
});

describe("parseStepAccounts", () => {
  it("reads done and not-done accounts with their reasons", () => {
    const accounts = parseStepAccounts(
      [
        "I shipped the migration.",
        "",
        "STEP 1: done — ran the migration against DEV",
        "STEP 2: not done — needs live authorisation from a human",
      ].join("\n"),
    );

    expect(accounts).toEqual([
      { number: 1, state: "done", note: "ran the migration against DEV" },
      { number: 2, state: "not-done", note: "needs live authorisation from a human" },
    ]);
  });

  it("treats an unrecognisable state as not done", () => {
    // Ambiguity has to fall on the side that holds the route: a state nobody can
    // classify is not evidence the work happened.
    const [account] = parseStepAccounts("STEP 3: probably fine — I think");
    expect(account.state).toBe("not-done");
  });

  it("keeps the last account for a number", () => {
    const accounts = parseStepAccounts(
      ["STEP 1: not done — blocked", "STEP 1: done — unblocked and did it"].join("\n"),
    );
    expect(accounts).toEqual([{ number: 1, state: "done", note: "unblocked and did it" }]);
  });

  it("does not read the word step in prose as an account", () => {
    expect(parseStepAccounts("The next step: rebuild the elements.")).toEqual([]);
  });

  it("accepts an account with no reason", () => {
    expect(parseStepAccounts("STEP 2: done")).toEqual([
      { number: 2, state: "done", note: undefined },
    ]);
  });

  it("keeps the stated word when a not-done gives no reason", () => {
    expect(parseStepAccounts("STEP 2: skipped")).toEqual([
      { number: 2, state: "not-done", note: "skipped" },
    ]);
  });
});

describe("stripStepAccounts", () => {
  it("removes the marker lines", () => {
    const stripped = stripStepAccounts(
      ["I did the work.", "STEP 1: done — ran it", "That is all."].join("\n"),
    );
    expect(stripped).not.toContain("STEP 1");
    expect(stripped.startsWith("I did the work.")).toBe(true);
    expect(stripped.endsWith("That is all.")).toBe(true);
  });

  it("does not leave a gap wide enough to read as a section break", () => {
    const stripped = stripStepAccounts(
      ["Report.", "", "STEP 1: done — ran it", "STEP 2: done — ran it", "", "More."].join("\n"),
    );
    expect(stripped).not.toMatch(/\n{3,}/);
  });
});

describe("unaccountedSteps", () => {
  const steps = [
    { number: 1, title: "Ship" },
    { number: 2, title: "Flag" },
    { number: 3, title: "Rebuild" },
  ];

  it("returns the steps the reply never mentioned", () => {
    const outstanding = unaccountedSteps(steps, [
      { number: 1, state: "done" },
      { number: 2, state: "not-done", note: "later" },
    ]);
    expect(outstanding).toEqual([{ number: 3, title: "Rebuild" }]);
  });

  it("counts a not-done step as accounted for", () => {
    const outstanding = unaccountedSteps(steps, [
      { number: 1, state: "not-done", note: "a" },
      { number: 2, state: "not-done", note: "b" },
      { number: 3, state: "not-done", note: "c" },
    ]);
    expect(outstanding).toEqual([]);
  });
});

describe("planStepInstruction", () => {
  it("lists every step and demands a line per step", () => {
    const text = planStepInstruction("docs/plan.md", [
      { number: 1, title: "Ship" },
      { number: 2, title: "Rebuild" },
    ]);
    expect(text).toContain("docs/plan.md");
    expect(text).toContain("1. Ship");
    expect(text).toContain("2. Rebuild");
    expect(text).toContain("STEP <number>: done");
  });

  it("says nothing when the plan has no numbered steps", () => {
    expect(planStepInstruction("docs/plan.md", [])).toBe("");
  });
});
