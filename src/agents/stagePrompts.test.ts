import { describe, it, expect } from "vitest";
import {
  StageContext,
  behaviourReviewPrompt,
  parseChecklistReply,
  parseNeedsInfo,
  parseSubtaskPlan,
  splitPrompt,
  subtaskPrompt,
} from "./stagePrompts";
import { TaskStage } from "../domain/taskPipeline";

const CONTEXT: StageContext = {
  taskName: "Fix dealer mapping",
  taskDescription: "Dealer id is lost when editing a customer.",
  branchName: "bug/dealer-mapping",
  baseBranch: "main",
};

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "fix",
    name: "Fix",
    kind: "implementation",
    status: "pending",
    intent: "Correct the root cause.",
    splittable: true,
    requiresApproval: false,
    subtasks: [],
    ...overrides,
  };
}

describe("prompt preamble", () => {
  it("states that the session has no memory of earlier stages", () => {
    // Each subtask runs in a fresh session; a prompt that assumed conversation
    // history would be wrong every time.
    for (const prompt of [
      splitPrompt(CONTEXT, stage()),
      subtaskPrompt(CONTEXT, stage(), { id: "fix-1", title: "T", prompt: "P", status: "pending" }),
      behaviourReviewPrompt(CONTEXT, stage({ kind: "behaviourReview" })),
    ]) {
      expect(prompt).toContain("no memory of earlier stages");
      expect(prompt).toContain("Fix dealer mapping");
      expect(prompt).toContain("bug/dealer-mapping");
    }
  });

  it("omits the description line when there is none", () => {
    const prompt = splitPrompt({ ...CONTEXT, taskDescription: undefined }, stage());
    expect(prompt).not.toContain("Description:");
  });
});

describe("the ask-for-information escape hatch", () => {
  it("is offered in every prompt, since a thin brief is normal", () => {
    for (const prompt of [
      splitPrompt(CONTEXT, stage()),
      subtaskPrompt(CONTEXT, stage(), { id: "fix-1", title: "T", prompt: "P", status: "pending" }),
      behaviourReviewPrompt(CONTEXT, stage({ kind: "behaviourReview" })),
    ]) {
      expect(prompt).toContain("NEEDS-INFO:");
      expect(prompt).toContain("do NOT guess");
    }
  });

  it("tells the agent to look before asking", () => {
    // Otherwise every thin brief becomes a question, which is just as useless.
    const prompt = splitPrompt(CONTEXT, stage());
    expect(prompt).toContain("already available to you");
    expect(prompt).toContain("ticket tooling");
  });
});

describe("exploration guidance", () => {
  it("steers every stage towards in-process tools over shell calls", () => {
    // On a measured route, shell calls averaged over ten seconds each — a process
    // launch apiece — while the file tools averaged zero for the same work.
    for (const prompt of [
      splitPrompt(CONTEXT, stage()),
      subtaskPrompt(CONTEXT, stage(), { id: "fix-1", title: "T", prompt: "P", status: "pending" }),
      behaviourReviewPrompt(CONTEXT, stage({ kind: "behaviourReview" })),
    ]) {
      expect(prompt).toContain("not shell commands");
      expect(prompt).toContain("combine the steps");
    }
  });
});

describe("parseNeedsInfo", () => {
  it("extracts the question", () => {
    expect(parseNeedsInfo("NEEDS-INFO: Which dealer fields are in scope?")).toBe(
      "Which dealer fields are in scope?",
    );
  });

  it("collects a multi-line question", () => {
    const question = parseNeedsInfo("NEEDS-INFO:\n- Which fields?\n- Which tenants?");
    expect(question).toContain("Which fields?");
    expect(question).toContain("Which tenants?");
  });

  it("tolerates a preface before the marker", () => {
    expect(
      parseNeedsInfo("I checked the code and the ticket tooling.\n\nNEEDS-INFO: Which tenant?"),
    ).toBe("Which tenant?");
  });

  it("ignores the marker mid-sentence, so prose does not pause the route", () => {
    expect(
      parseNeedsInfo("I considered replying NEEDS-INFO: but the code was clear."),
    ).toBeUndefined();
  });

  it("still pauses when the marker carries no question", () => {
    expect(parseNeedsInfo("NEEDS-INFO:")).toContain("did not say what");
  });

  it("returns nothing for an ordinary reply", () => {
    expect(parseNeedsInfo("Done — added the explicit mapping.")).toBeUndefined();
  });
});

describe("splitPrompt", () => {
  it("bounds the split and asks for independently executable units", () => {
    const prompt = splitPrompt(CONTEXT, stage());
    expect(prompt).toContain("between 1 and 5");
    expect(prompt).toContain("Prefer fewer");
    expect(prompt).toContain("own fresh session");
    expect(prompt).toContain("Do not implement anything yet");
  });
});

describe("subtaskPrompt", () => {
  it("carries the objective and confines the work to it", () => {
    const prompt = subtaskPrompt(CONTEXT, stage(), {
      id: "fix-1",
      title: "Map DealerId explicitly",
      prompt: "Add an explicit member mapping.",
      status: "pending",
    });
    expect(prompt).toContain("Map DealerId explicitly");
    expect(prompt).toContain("Add an explicit member mapping.");
    expect(prompt).toContain("Stay within this objective");
  });

  it("leads with the workflow command but still carries the brief", () => {
    // Sending "/review" alone would leave a cold session with no task and no
    // brief, and command bodies typically say "investigate this request".
    const prompt = subtaskPrompt(CONTEXT, stage(), {
      id: "review-1",
      title: "Review the diff",
      prompt: "Check backwards compatibility.",
      workflow: "/review",
      status: "pending",
    });
    expect(prompt.startsWith("/review\n")).toBe(true);
    expect(prompt).toContain("Fix dealer mapping");
    expect(prompt).toContain("Dealer id is lost when editing a customer.");
    expect(prompt).toContain("Check backwards compatibility.");
    expect(prompt).toContain("NEEDS-INFO:");
  });
});

describe("behaviourReviewPrompt", () => {
  it("asks for a tester checklist and excludes what other stages cover", () => {
    const prompt = behaviourReviewPrompt(
      CONTEXT,
      stage({ kind: "behaviourReview", intent: "Check downstream consumers." }),
    );
    expect(prompt).toContain("Check downstream consumers.");
    expect(prompt).toContain("what would indicate a regression");
    expect(prompt).toContain("settled by reading the code");
    expect(prompt).toContain("NONE");
  });
});

describe("parseSubtaskPlan", () => {
  it("parses a numbered list with em-dash separators", () => {
    const specs = parseSubtaskPlan(`1. Map DealerId — add an explicit member mapping.
2. Cover nulls — handle a missing dealer without throwing.`);
    expect(specs).toEqual([
      { title: "Map DealerId", prompt: "add an explicit member mapping." },
      { title: "Cover nulls", prompt: "handle a missing dealer without throwing." },
    ]);
  });

  it("accepts colons, hyphens and en dashes as separators", () => {
    expect(parseSubtaskPlan("1. A: do a").map((s) => s.title)).toEqual(["A"]);
    expect(parseSubtaskPlan("1. B - do b").map((s) => s.title)).toEqual(["B"]);
    expect(parseSubtaskPlan("1. C – do c").map((s) => s.title)).toEqual(["C"]);
  });

  it("accepts bullets as well as numbers", () => {
    expect(parseSubtaskPlan("- A — do a\n* B — do b")).toHaveLength(2);
  });

  it("ignores prose the model wraps around the list", () => {
    const specs = parseSubtaskPlan(`Sure! Here is my plan:

1. First thing — do it.

Let me know if you want changes.`);
    expect(specs).toEqual([{ title: "First thing", prompt: "do it." }]);
  });

  it("uses the whole line when there is no separator", () => {
    const specs = parseSubtaskPlan("1. Just do the thing");
    expect(specs).toEqual([
      { title: "Just do the thing", prompt: "Just do the thing" },
    ]);
  });

  it("truncates an over-long title but keeps the full prompt", () => {
    const long = `1. ${"x".repeat(200)}`;
    const [spec] = parseSubtaskPlan(long);
    expect(spec.title.length).toBeLessThanOrEqual(60);
    expect(spec.prompt.length).toBe(200);
  });

  it("returns nothing for an unparseable reply, so the caller can fall back", () => {
    expect(parseSubtaskPlan("I don't think this needs splitting.")).toEqual([]);
    expect(parseSubtaskPlan("")).toEqual([]);
  });
});

describe("parseChecklistReply", () => {
  it("parses a bulleted checklist", () => {
    expect(
      parseChecklistReply("- Edit an existing customer\n- Run a dealer report"),
    ).toEqual(["Edit an existing customer", "Run a dealer report"]);
  });

  it("treats NONE as an empty but valid answer", () => {
    // Distinct from a parse failure: the reviewer decided nothing needs a human.
    expect(parseChecklistReply("NONE")).toEqual([]);
    expect(parseChecklistReply("  none  ")).toEqual([]);
    expect(parseChecklistReply("- NONE")).toEqual([]);
  });

  it("ignores surrounding prose", () => {
    expect(
      parseChecklistReply("Here is what to check:\n\n- Exports still balance\n\nThanks."),
    ).toEqual(["Exports still balance"]);
  });

  it("accepts numbered items", () => {
    expect(parseChecklistReply("1. Check totals\n2) Check headings")).toEqual([
      "Check totals",
      "Check headings",
    ]);
  });

  it("returns nothing for an empty reply", () => {
    expect(parseChecklistReply("")).toEqual([]);
  });
});
