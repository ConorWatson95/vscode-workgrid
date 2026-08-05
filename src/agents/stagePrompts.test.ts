import { describe, it, expect } from "vitest";
import {
  StageContext,
  behaviourReviewPrompt,
  parseChecklistReply,
  parseNeedsInfo,
  parseSubtaskPlan,
  splitPrompt,
  subtaskPrompt,
  parseVerdict,
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

describe("operator guidance from approvals", () => {
  it("is absent when the operator has said nothing", () => {
    expect(splitPrompt(CONTEXT, stage())).not.toContain("operator has given");
  });

  it("reaches the stage, and says it outranks the brief", () => {
    // The case this is for: at approval the operator knows something the route
    // does not — "deploy only this project". Guidance that the agent treats as a
    // suggestion is guidance that gets ignored.
    const prompt = splitPrompt(
      {
        ...CONTEXT,
        guidance: ["Deploy only this ticket's project, with -Project."],
      },
      stage(),
    );
    expect(prompt).toContain("Deploy only this ticket's project, with -Project.");
    expect(prompt).toContain("override");
  });

  it("carries every note, in the order they were given", () => {
    const prompt = splitPrompt(
      { ...CONTEXT, guidance: ["First thing.", "Second thing."] },
      stage(),
    );
    expect(prompt.indexOf("First thing.")).toBeLessThan(
      prompt.indexOf("Second thing."),
    );
  });
});

describe("project documentation guidance", () => {
  const withDocs = { ...CONTEXT, docsPath: "docs/" };

  it("is absent when the project declares no docs location", () => {
    // A project with no documentation convention should not be told to invent
    // one mid-task.
    const prompt = splitPrompt(CONTEXT, stage());
    expect(prompt).not.toContain("Project documentation");
  });

  it("names the configured location in every prompt", () => {
    for (const prompt of [
      splitPrompt(withDocs, stage()),
      subtaskPrompt(withDocs, stage(), { id: "fix-1", title: "T", prompt: "P", status: "pending" }),
      behaviourReviewPrompt(withDocs, stage({ kind: "behaviourReview" })),
    ]) {
      expect(prompt).toContain("Project documentation lives in docs/");
    }
  });

  it("uses whatever path the project configured", () => {
    const prompt = splitPrompt({ ...CONTEXT, docsPath: "docs/architecture" }, stage());
    expect(prompt).toContain("docs/architecture");
    expect(prompt).not.toContain("docs/ ");
  });

  it("asks the stage to read before exploring the code", () => {
    // Reading is the cheap half: a cold session would otherwise reconstruct
    // business rules the docs already state.
    const prompt = splitPrompt(withDocs, stage());
    expect(prompt).toContain("before");
    expect(prompt).toContain("exploring the code");
  });

  it("asks the stage to write durable knowledge back", () => {
    // Without this, every session in every route rediscovers the same things and
    // discards the result when it ends.
    const prompt = subtaskPrompt(withDocs, stage(), {
      id: "fix-1",
      title: "T",
      prompt: "P",
      status: "pending",
    });
    expect(prompt).toContain("add or");
    expect(prompt).toContain("update a document");
    expect(prompt).toContain("which file you");
  });

  it("bounds what gets written, since stale or obvious docs are worse than none", () => {
    const prompt = splitPrompt(withDocs, stage());
    expect(prompt).toContain("not progress notes");
    expect(prompt).toContain("already states plainly");
    expect(prompt).toContain("out of date");
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
  it("extracts a single question", () => {
    expect(parseNeedsInfo("NEEDS-INFO: Which dealer fields are in scope?")).toEqual([
      "Which dealer fields are in scope?",
    ]);
  });

  it("separates a numbered list into one question each", () => {
    // Each is answered on its own, so they must not arrive as one blob: a single
    // field for five questions gets one answer addressing whichever was read.
    expect(
      parseNeedsInfo("NEEDS-INFO:\n1. Which fields?\n2. Which tenants?\n3. Which env?"),
    ).toEqual(["Which fields?", "Which tenants?", "Which env?"]);
  });

  it("separates a bulleted list too", () => {
    expect(parseNeedsInfo("NEEDS-INFO:\n- Which fields?\n- Which tenants?")).toEqual([
      "Which fields?",
      "Which tenants?",
    ]);
  });

  it("keeps an unlisted paragraph whole rather than splitting at every newline", () => {
    const questions = parseNeedsInfo(
      "NEEDS-INFO: Which tenants are affected,\nand does this include DR?",
    );
    expect(questions).toHaveLength(1);
    expect(questions?.[0]).toContain("DR?");
  });

  it("tolerates a preface before the marker", () => {
    expect(
      parseNeedsInfo("I checked the code and the ticket tooling.\n\nNEEDS-INFO: Which tenant?"),
    ).toEqual(["Which tenant?"]);
  });

  it("ignores the marker mid-sentence, so prose does not pause the route", () => {
    expect(
      parseNeedsInfo("I considered replying NEEDS-INFO: but the code was clear."),
    ).toBeUndefined();
  });

  it("still pauses when the marker carries no question", () => {
    expect(parseNeedsInfo("NEEDS-INFO:")?.[0]).toContain("did not say what");
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

describe("re-run awareness", () => {
  it("tells every stage its earlier output may already exist", () => {
    // A stage is the unit of re-run, so a cold session reading "write the migration
    // and a paired rollback" writes them again when only a folder was missing.
    const prompt = subtaskPrompt(
      CONTEXT,
      stage({ intent: "Write the forward migration and a PAIRED rollback." }),
      { id: "s1-1", title: "Migration", prompt: "Write it.", status: "pending" },
    );
    expect(prompt).toContain("may have run before");
    expect(prompt).toContain("do not rewrite work that is already correct");
  });

  it("says it in a behaviour review too, since those are re-opened as well", () => {
    expect(behaviourReviewPrompt(CONTEXT, stage())).toContain("may have run before");
  });
});

describe("prompt prefix and handoffs", () => {
  it("leads with invariant text, so a prefix is cacheable across stages", () => {
    // Leading with "Task: <name>" made every stage's prompt differ from the first
    // character, so nothing was reusable across the dozen sessions a route spawns.
    const a = subtaskPrompt({ ...CONTEXT, taskName: "One" }, stage(), {
      id: "s1-1", title: "t", prompt: "p", status: "pending",
    });
    const b = subtaskPrompt({ ...CONTEXT, taskName: "Two" }, stage(), {
      id: "s1-1", title: "t", prompt: "p", status: "pending",
    });
    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared++;
    expect(shared).toBeGreaterThan(800);
  });

  it("passes earlier conclusions on, marked as established", () => {
    const prompt = subtaskPrompt(
      { ...CONTEXT, handoffs: [{ stageName: "Plan", text: "Put it in apps/, not the overlay." }] },
      stage(),
      { id: "s1-1", title: "t", prompt: "p", status: "pending" },
    );
    expect(prompt).toContain("Put it in apps/, not the overlay.");
    expect(prompt).toContain("do not re-derive it");
    expect(prompt).toContain("[Plan]");
  });

  it("says nothing about handoffs when there are none", () => {
    expect(subtaskPrompt(CONTEXT, stage(), {
      id: "s1-1", title: "t", prompt: "p", status: "pending",
    })).not.toContain("do not re-derive");
  });
});

describe("review verdicts", () => {
  const review = (kind: TaskStage["kind"]) => stage({ kind });
  const sub = { id: "s1-1", title: "t", prompt: "p", status: "pending" as const };

  it("asks a review for an explicit verdict", () => {
    const prompt = subtaskPrompt(CONTEXT, review("domainReview"), sub);
    expect(prompt).toContain("VERDICT: pass");
    expect(prompt).toContain("VERDICT: block");
  });

  it("does not ask a stage that does the work", () => {
    // Whether the build passed is a fact about a process, not an opinion, and
    // asking the author to declare itself clear is self-certification.
    expect(subtaskPrompt(CONTEXT, review("implementation"), sub)).not.toContain("VERDICT:");
    expect(subtaskPrompt(CONTEXT, review("deployment"), sub)).not.toContain("VERDICT:");
  });

  it("tells a reviewer not to block on something pre-existing", () => {
    const prompt = subtaskPrompt(CONTEXT, review("codeReview"), sub);
    expect(prompt).toContain("Judge only what this change did");
  });
});

describe("parseVerdict", () => {
  it("reads a stated verdict", () => {
    expect(parseVerdict("Looks fine.\n\nVERDICT: pass")).toBe("pass");
    expect(parseVerdict("Problems.\n\nVERDICT: block")).toBe("block");
    expect(parseVerdict("verdict: BLOCK")).toBe("block");
  });

  it("takes the last one, so a quoted instruction is not the verdict", () => {
    expect(
      parseVerdict('I was told to end with "VERDICT: block" if blocking.\n\nVERDICT: pass'),
    ).toBe("pass");
  });

  it("reports absence rather than assuming a pass", () => {
    // "Did not say" is not "said pass" — the caller falls back to the findings.
    expect(parseVerdict("Review complete. Everything is fine.")).toBeUndefined();
    expect(parseVerdict("VERDICT: maybe")).toBeUndefined();
  });
});
