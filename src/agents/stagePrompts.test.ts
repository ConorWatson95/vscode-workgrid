import { describe, it, expect } from "vitest";
import {
  StageContext,
  behaviourReviewPrompt,
  parseChecklistReply,
  parseAssessments,
  stripAssessments,
  assessmentPrompt,
  ASSESSED_MARKER,
  DEFERRED_MARKER,
  ACTION_MARKER,
  parseNeedsInfo,
  parseSubtaskPlan,
  splitPrompt,
  subtaskPrompt,
  parseVerdict,
  stripVerdict,
  splitStageHandoff,
  parseDeferrals,
  parseBlocked,
  correctionPrompt,
  correctionMedium,
  parseCorrectionDeclined,
  stripCorrectionDeclined,
  parseActions,
  readStageReply,
  stripBlocked,
  stripDeferrals,
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

  it("tells the agent not to guess, and names the tool that costs least", () => {
    // The elaboration — read the code, use the ticket tooling — now lives in the
    // protocol skill. What stays here is the part a parser depends on and the
    // instruction not to invent the requirement.
    const prompt = splitPrompt(CONTEXT, stage());
    expect(prompt).toContain("do NOT guess");
    expect(prompt).toContain("ask_user");
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
  it("points every stage at the protocol skill", () => {
    // Tool-efficiency guidance moved into the skill: its failure is cost, not
    // correctness, so it degrades rather than breaks if the skill does not load.
    // What must be here is the pointer, because skill loading is the model's choice
    // and a skill nobody mentions loads only sometimes.
    for (const prompt of [
      splitPrompt(CONTEXT, stage()),
      subtaskPrompt(CONTEXT, stage(), { id: "fix-1", title: "T", prompt: "P", status: "pending" }),
      behaviourReviewPrompt(CONTEXT, stage({ kind: "behaviourReview" })),
    ]) {
      expect(prompt).toContain("harness-protocol");
      expect(prompt).toContain("Read it");
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
    ).toEqual([{ text: "Edit an existing customer" }, { text: "Run a dealer report" }]);
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
    ).toEqual([{ text: "Exports still balance" }]);
  });

  it("accepts numbered items", () => {
    expect(parseChecklistReply("1. Check totals\n2) Check headings")).toEqual([
      { text: "Check totals" },
      { text: "Check headings" },
    ]);
  });

  it("returns nothing for an empty reply", () => {
    expect(parseChecklistReply("")).toEqual([]);
  });

  /**
   * Scoping, which is what lets one route verify the same change in two environments.
   * The tag is only read as a scope when it names one the route declared — see
   * `splitScopeTag` — so a review describing an item as `[Excel]` does not have that
   * silently removed from what the item says.
   */
  it("reads a scope tag that names a declared gate", () => {
    expect(
      parseChecklistReply(
        "- [local] Run the report locally\n- [dev-site] Open it on DEV",
        ["local", "dev-site"],
      ),
    ).toEqual([
      { text: "Run the report locally", scope: "local" },
      { text: "Open it on DEV", scope: "dev-site" },
    ]);
  });

  it("leaves an item untagged when the route declares no scopes", () => {
    expect(parseChecklistReply("- [local] Run the report locally")).toEqual([
      { text: "[local] Run the report locally" },
    ]);
  });

  it("keeps an unrecognised bracket in the text", () => {
    expect(parseChecklistReply("- [Excel] Compare the headers", ["local"])).toEqual([
      { text: "[Excel] Compare the headers" },
    ]);
  });

  // An untagged item is still an item: it is assigned to a gate downstream rather than
  // dropped, so the parser must not discard it for lacking a tag.
  it("keeps an untagged item when scopes are declared", () => {
    expect(parseChecklistReply("- Check the totals", ["local", "dev-site"])).toEqual([
      { text: "Check the totals" },
    ]);
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
    // Deliberately not moved to the skill with the rest of the guidance: this one
    // fails silently and expensively, so it must be present whether it loads or not.
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

describe("readStageReply — the order the markers come off in", () => {
  it("does not read a marker mentioned inside the handoff block", () => {
    // The handoff is written for a later stage, so it restates what happened. A
    // handoff describing a decline must not create a second one.
    const reply = [
      "Done the promotion.",
      "ACTION: open https://example.com/pr/1 and merge it",
      "HANDOFF:",
      "I raised an ACTION: open the PR, and DEFERRED: the retention job.",
    ].join("\n");
    const read = readStageReply(reply);
    expect(read.actions).toEqual(["open https://example.com/pr/1 and merge it"]);
    expect(read.deferrals).toEqual([]);
  });

  it("keeps a verdict out of the handoff block", () => {
    const reply = "Reviewed.\nHANDOFF:\nThe mapping is in Profile.cs.\nVERDICT: block";
    const read = readStageReply(reply);
    expect(read.verdict).toBe("block");
    expect(read.handoff).not.toContain("VERDICT");
  });

  it("returns a report with every marker removed", () => {
    const reply = [
      "Promoted the change.",
      "ACTION: register the endpoint in the Brevo console",
      "DEFERRED: the retention job needs a schedule",
      "BLOCKED: nothing else to do",
    ].join("\n");
    const read = readStageReply(reply);
    expect(read.report).toBe("Promoted the change.");
    expect(read.actions).toHaveLength(1);
    expect(read.deferrals).toHaveLength(1);
    expect(read.blocked).toBe("nothing else to do");
  });
});

describe("steps only the operator can take", () => {
  const sub = { id: "s1-1", title: "t", prompt: "p", status: "pending" as const };

  it("is asked for in every stage's prompt, with the URL kept verbatim", () => {
    const prompt = subtaskPrompt(CONTEXT, stage({ kind: "deployment" }), sub);
    expect(prompt).toContain("ACTION:");
    expect(prompt).toContain("verbatim");
    expect(prompt).toContain("the route stops");
  });

  it("reads every line, since one stage can need several", () => {
    const reply = [
      "Promoted to UAT.",
      "ACTION: open https://bitbucket.org/x/pull-requests/9?dest=UAT and merge it",
      "ACTION: register the webhook URL in the Brevo console for NissanGB",
    ].join("\n");
    expect(parseActions(reply)).toEqual([
      "open https://bitbucket.org/x/pull-requests/9?dest=UAT and merge it",
      "register the webhook URL in the Brevo console for NissanGB",
    ]);
  });

  it("ignores the word in prose", () => {
    expect(parseActions("No further action is needed here.")).toEqual([]);
  });

  it("points a question at NEEDS-INFO rather than at itself", () => {
    const prompt = subtaskPrompt(CONTEXT, stage({ kind: "deployment" }), sub);
    expect(prompt).toContain("do not use them to ask a question");
  });
});

describe("reporting that a stage's own work went undone", () => {
  const sub = { id: "s1-1", title: "t", prompt: "p", status: "pending" as const };

  it("asks a working stage for the marker", () => {
    const prompt = subtaskPrompt(CONTEXT, stage({ kind: "deployment" }), sub);
    expect(prompt).toContain("BLOCKED:");
  });

  it("does not ask a review, which already has VERDICT for this", () => {
    // Two overlapping protocols means the model picks one, and which one is a
    // coin toss.
    const prompt = subtaskPrompt(CONTEXT, stage({ kind: "codeReview" }), sub);
    expect(prompt).not.toContain("BLOCKED:");
    expect(prompt).toContain("VERDICT:");
  });

  it("never asks for a marker meaning success", () => {
    // A stage that does work has no verdict to give on itself; asking it to declare
    // itself clear is the self-certification the harness exists to remove.
    const prompt = subtaskPrompt(CONTEXT, stage({ kind: "deployment" }), sub);
    expect(prompt).toContain("Never use this line to report work you did complete");
  });

  it("reads the reason from the marker line", () => {
    const reply =
      "git log --all --grep=NMGB-2795 returns no commits.\n" +
      "BLOCKED: nothing for this ticket is committed, so there is no SHA to cherry-pick";
    expect(parseBlocked(reply)).toBe(
      "nothing for this ticket is committed, so there is no SHA to cherry-pick",
    );
  });

  it("ignores the word in prose", () => {
    expect(parseBlocked("Published. The job was blocked on a lock, now cleared.")).toBeUndefined();
  });

  it("takes only the first, since a stage has one reason for not acting", () => {
    const reply = "BLOCKED: nothing committed\nBLOCKED: also the worktree is missing";
    expect(parseBlocked(reply)).toBe("nothing committed");
  });

  it("strips the marker but keeps the reasoning a reader needs", () => {
    const reply = "UAT's tip is the RU-547 promotion.\nBLOCKED: nothing has reached UAT";
    expect(stripBlocked(reply)).toBe("UAT's tip is the RU-547 promotion.");
  });

  it("does not leave a gap that reads as a section break", () => {
    // The marker normally has prose after it, so the removed line is mid-reply.
    const reply = "Nothing is committed.\nBLOCKED: no SHA to cherry-pick\nI changed nothing.";
    expect(stripBlocked(reply)).toBe("Nothing is committed.\n\nI changed nothing.");
  });
});

describe("declining work that belongs to another stage", () => {
  const sub = { id: "s1-1", title: "t", prompt: "p", status: "pending" as const };

  it("asks for a marker rather than a mention in the prose", () => {
    // The whole failure: every stage said "not mine" in a reply nobody parsed,
    // and the work surfaced at a live publish.
    const prompt = subtaskPrompt(CONTEXT, stage(), sub);
    expect(prompt).toContain("DEFERRED:");
    expect(prompt).toContain("one line per item");
  });

  it("tells a stage to ask when no stage owns the work, rather than decline it", () => {
    // The distinction the engine has always defined a deferral by, and the prompt
    // did not draw: work belonging to a *later stage* is routine to decline, work
    // belonging to *nobody* is the case that reached a live publish. Declining both
    // the same way makes them indistinguishable to the reader who confirms them.
    const prompt = subtaskPrompt(CONTEXT, stage(), sub);
    expect(prompt).toContain("A later stage clearly owns it");
    expect(prompt).toContain("No stage owns it");
    expect(prompt).toMatch(/Ask first, while you\s+still have the context/);
  });

  it("reserves the marker for work no stage owns", () => {
    // The inflation this caused: one task carried forty declined items, thirty of
    // them the same four observations reworded by each stage that noticed them —
    // every one naming the stage that already owned it. A marker that holds the route
    // until a human writes a sentence about ownership is noise when the stage has
    // just established that the route owns it.
    const prompt = subtaskPrompt(CONTEXT, stage(), sub);
    expect(prompt).toMatch(/Say so in your report, in a sentence, and move on/);
    expect(prompt).toMatch(/only case the marker is for/);
  });

  it("reads one item per line, verbatim", () => {
    const reply = [
      "I corrected the mapping.",
      "DEFERRED: the export structure does not exist on live; belongs to publish",
      "DEFERRED: the retention job needs a schedule",
    ].join("\n");
    expect(parseDeferrals(reply)).toEqual([
      "the export structure does not exist on live; belongs to publish",
      "the retention job needs a schedule",
    ]);
  });

  it("ignores the word inside prose", () => {
    // "I deferred to the existing convention" is not a decline, and treating it
    // as one would hold a deployment on a turn of phrase.
    expect(parseDeferrals("I deferred to the existing convention here.")).toEqual([]);
  });

  it("ignores a stage answering the question with nothing", () => {
    // Seen in the wild, from a runtime-QA stage: `DEFERRED: none — this is Nissan GB
    // only, so no second-manufacturer checks are needed`. Recorded as written it
    // became an outstanding item, and an outstanding item holds the route in front of
    // the next deployment — so a stage saying "nothing" stopped a DEV push.
    expect(
      parseDeferrals(
        "DEFERRED: none — this is Nissan GB only with no other consumer of the proc",
      ),
    ).toEqual([]);
    expect(parseDeferrals("DEFERRED: nothing")).toEqual([]);
    expect(parseDeferrals("DEFERRED: N/A")).toEqual([]);
    expect(parseDeferrals("DEFERRED: no deferrals.")).toEqual([]);
  });

  it("still reads a real item that happens to open with 'none of'", () => {
    // The guard has to be narrow: "none of the migrations carry a USE statement" is a
    // genuine decline, and dropping it would be the same silent loss in reverse.
    expect(
      parseDeferrals("DEFERRED: none of the migrations carry an explicit USE statement"),
    ).toEqual(["none of the migrations carry an explicit USE statement"]);
  });

  it("strips the lines from what a reader sees", () => {
    const stripped = stripDeferrals("Done.\nDEFERRED: something else\nAll good.");
    expect(stripped).not.toContain("DEFERRED:");
    expect(stripped).toContain("Done.");
    expect(stripped).toContain("All good.");
  });
});

describe("the handoff a stage writes for later stages", () => {
  const sub = { id: "s1-1", title: "t", prompt: "p", status: "pending" as const };

  it("is asked for only when the route marks the stage as one", () => {
    // Prompt space every stage pays for, so a project decides where continuity
    // is worth it.
    expect(subtaskPrompt(CONTEXT, stage({ handoff: true }), sub)).toContain("HANDOFF:");
    expect(subtaskPrompt(CONTEXT, stage(), sub)).not.toContain("HANDOFF:");
  });

  it("asks for what a later stage could not re-derive, not a description of the diff", () => {
    const prompt = subtaskPrompt(CONTEXT, stage({ handoff: true }), sub);
    expect(prompt).toContain("could NOT work out by reading");
    expect(prompt).toContain("Do not describe the diff");
  });

  it("moves the verdict line after the block, so both instructions can be obeyed", () => {
    // Given contradictory instructions the model drops one, and the verdict is
    // the one that stops a route from deploying over a real finding.
    const both = subtaskPrompt(CONTEXT, stage({ kind: "codeReview", handoff: true }), sub);
    expect(both).toContain("after the handoff block");
    const verdictOnly = subtaskPrompt(CONTEXT, stage({ kind: "codeReview" }), sub);
    expect(verdictOnly).toContain("End your reply with a single line");
  });
});

describe("splitStageHandoff", () => {
  it("separates the report from the block below the marker", () => {
    const split = splitStageHandoff("I fixed the mapping.\n\nHANDOFF:\n## Done\n- fixed it");
    expect(split.report).toBe("I fixed the mapping.");
    expect(split.handoff).toBe("## Done\n- fixed it");
  });

  it("takes the last marker, so quoting the instruction does not fool it", () => {
    const reply = [
      "I was told to end with HANDOFF: and a summary.",
      "",
      "HANDOFF:",
      "## Summary",
      "Done.",
    ].join("\n");
    // The first mention is inline prose, not a marker on its own line.
    expect(splitStageHandoff(reply).handoff).toBe("## Summary\nDone.");
  });

  it("returns no handoff when there is no marker, so the caller can fall back", () => {
    const split = splitStageHandoff("Just a reply.");
    expect(split.handoff).toBeUndefined();
    expect(split.report).toBe("Just a reply.");
  });

  it("treats an announced but empty block as none", () => {
    // Otherwise a later stage is told this one concluded nothing, which is a
    // different claim from this one not having said.
    expect(splitStageHandoff("Work done.\n\nHANDOFF:\n\n  ").handoff).toBeUndefined();
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

describe("stripVerdict", () => {
  it("removes the marker line, which is protocol and not prose", () => {
    // It was reaching the report, the handoff and every later stage's prompt
    // verbatim: a document about stored procedures ending in a bare "VERDICT: block".
    const reply = "The change targets the wrong proc.\n\nVERDICT: block";
    expect(stripVerdict(reply)).toBe("The change targets the wrong proc.");
  });

  it("leaves a reply that has no verdict untouched", () => {
    expect(stripVerdict("Nothing to report.")).toBe("Nothing to report.");
  });

  it("closes the gap when the marker was not the last line", () => {
    const reply = ["Findings above.", "", "VERDICT: pass", "", "Notes below."].join("\n");
    expect(stripVerdict(reply)).toBe("Findings above.\n\nNotes below.");
  });

  it("does not touch a sentence that merely mentions the marker", () => {
    const reply = "I was asked to end with VERDICT: pass or block as a final line.";
    expect(stripVerdict(reply)).toBe(reply);
  });

  it("still parses the verdict from the text it strips", () => {
    const reply = "Wrong proc.\n\nVERDICT: block";
    expect(parseVerdict(reply)).toBe("block");
    expect(parseVerdict(stripVerdict(reply))).toBeUndefined();
  });
});

describe("a behaviour review's output channels", () => {
  // The bug: a behaviour review had one channel — the checklist — so work it noticed
  // nobody had done went out as a verification item, and a person was asked to deploy
  // a migration under the heading "verification items raised". It was not being lazy;
  // it had one door.
  it("can decline work and name human-only steps, not just list checks", () => {
    const prompt = behaviourReviewPrompt(CONTEXT, stage({ kind: "behaviourReview" }));
    expect(prompt).toContain(DEFERRED_MARKER);
    expect(prompt).toContain(ACTION_MARKER);
  });

  it("says a checklist item is an observation and never work", () => {
    const prompt = behaviourReviewPrompt(CONTEXT, stage({ kind: "behaviourReview" }));
    expect(prompt).toContain("observes");
    expect(prompt).toContain("It is never work");
  });

  // The reply now legitimately carries marker lines beside the bullets, and the
  // checklist parser must not turn those into checklist items.
  it("parses a mixed reply into checks only", () => {
    const items = parseChecklistReply(
      [
        `${DEFERRED_MARKER} Deploy 001-proc.sql to the DEV database`,
        "- Open the parts scorecard for a dealer with no sales and confirm it reads 0.0%",
        `${ACTION_MARKER} Merge the pull request once approved`,
      ].join("\n"),
    );
    expect(items).toEqual([
      {
        text: "Open the parts scorecard for a dealer with no sales and confirm it reads 0.0%",
      },
    ]);
  });
});

describe("the route a stage is part of", () => {
  const ROUTE_CONTEXT = {
    ...CONTEXT,
    routeStages: [
      { name: "Implement", intent: "Write the proc.", position: "earlier" as const },
      { name: "Behaviour review", intent: "Plan the checks.", position: "current" as const },
      { name: "Deploy to DEV", intent: "Run the migrations.", position: "later" as const },
    ],
  };

  // The failure this closes: a behaviour review raised "deploy this migration to DEV"
  // as a verification item for a human, when the route already had a deployment stage
  // two steps later. It was not wrong that the work was outstanding — it had no way to
  // know anyone was going to do it.
  it("names every stage, marks the current one, and says later ones have owners", () => {
    const prompt = behaviourReviewPrompt(ROUTE_CONTEXT, stage({ kind: "behaviourReview" }));
    expect(prompt).toContain("Deploy to DEV — Run the migrations.");
    expect(prompt).toContain("(you are here)");
    expect(prompt).toContain("do not raise it as outstanding");
  });

  it("reaches an implementation subtask too, not only reviews", () => {
    const prompt = subtaskPrompt(ROUTE_CONTEXT, stage(), {
      id: "s1-1", title: "T", prompt: "P", status: "pending",
    });
    expect(prompt).toContain("Deploy to DEV");
  });

  it("says nothing about a route when there is none to describe", () => {
    expect(subtaskPrompt(CONTEXT, stage(), {
      id: "s1-1", title: "T", prompt: "P", status: "pending",
    })).not.toContain("you are here");
  });
});

describe("assessing work that already exists", () => {
  it("reads a per-stage conclusion with its evidence", () => {
    const parsed = parseAssessments(
      [
        "ASSESSED: implement done — p_Parts_Get_ByDescriptionCode exists in the worktree",
        "ASSESSED: permissions not done — no row in p_Permissions_Get_FieldValues",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      {
        stageId: "implement",
        done: true,
        evidence: "p_Parts_Get_ByDescriptionCode exists in the worktree",
      },
      {
        stageId: "permissions",
        done: false,
        evidence: "no row in p_Permissions_Get_FieldValues",
      },
    ]);
  });

  // A reply that restates the instruction, or corrects itself later, must not be able
  // to flip a stage to skipped after the fact.
  it("keeps the first mention of a stage", () => {
    const parsed = parseAssessments(
      ["ASSESSED: deploy not done — nothing in DEV", "ASSESSED: deploy done — actually fine"].join("\n"),
    );
    expect(parsed).toEqual([
      { stageId: "deploy", done: false, evidence: "nothing in DEV" },
    ]);
  });

  it("tolerates a missing separator and other dashes", () => {
    expect(parseAssessments("ASSESSED: build done the dll is present")).toEqual([
      { stageId: "build", done: true, evidence: "the dll is present" },
    ]);
  });

  it("ignores the marker inside prose", () => {
    expect(parseAssessments("I would say ASSESSED: build done here")).toEqual([]);
  });

  it("strips its lines from the report", () => {
    const report = stripAssessments("Findings.\nASSESSED: build done — present\nEnd.");
    expect(report).not.toContain("ASSESSED:");
    expect(report).toContain("Findings.");
    expect(report).toContain("End.");
  });

  it("tells the stage to judge existence, not quality, and to change nothing", () => {
    const prompt = assessmentPrompt(CONTEXT, stage({ kind: "assessment" }));
    expect(prompt).toContain("do not fix");
    expect(prompt).toContain("never whether it is good");
    expect(prompt).toContain(ASSESSED_MARKER);
  });
});

describe("assessing work that lives outside the repository", () => {
  // The case that forced it: SQL deployed to DEV before it was ever in source
  // control, and a task closed to be migrated onto the harness. No branch, no
  // worktree, nothing in any diff — and the work is unmistakably done.
  it("tells the stage to look at the environments, not only the diff", () => {
    const prompt = assessmentPrompt(CONTEXT, stage({ kind: "assessment" }));
    expect(prompt).toContain("environments this work targets");
    expect(prompt).toContain("no diff will ever show it");
  });

  // The distinction that keeps this from disabling the route it is attached to.
  it("says an object outside source control is not done", () => {
    const prompt = assessmentPrompt(CONTEXT, stage({ kind: "assessment" }));
    expect(prompt).toContain("not done");
    expect(prompt).toContain("absent from the repository");
  });
});

/**
 * A correction saying the finding needs a re-run, not a fix.
 *
 * The prompt asked for this behaviour long before anything parsed it, which is the
 * one arrangement the harness treats as a bug by definition: a stage did what it was
 * told, and the runtime read a tidy session exit as a completed repair.
 */
/**
 * A correction must stay in its own stage's medium.
 *
 * A finding is written about where the problem was noticed, which is almost always the
 * code. Told "go straight to the code the finding names", a planning stage handed a
 * controller defect went and fixed the controller — competently, narrowly, and in the
 * wrong stage. The plan then still omitted the work, so the implementation stages were
 * about to re-run cold against a document that never mentioned it and no STEP would
 * have accounted for it.
 */
describe("what a correction is allowed to change", () => {
  const PREVIOUS = "Wrote the plan for the report.";

  it("tells a planning stage it is correcting the plan, not the code", () => {
    const prompt = correctionPrompt(
      CONTEXT,
      stage({ kind: "planning" }),
      "The controller does not reset all session context variables.",
      PREVIOUS,
    );
    expect(prompt).toContain("the plan this stage produced");
    expect(prompt).not.toContain("Go straight to the code");
  });

  it("still points an implementation stage at the code", () => {
    const prompt = correctionPrompt(CONTEXT, stage(), "Wrong cast.", PREVIOUS);
    expect(prompt).toContain("the code this stage wrote");
  });

  it("says not to do the owning stage's work here", () => {
    // The whole failure in one sentence: the fix belonged to a later stage, and doing
    // it early hid it from every check that asks whether a stage did its own work.
    const prompt = correctionPrompt(CONTEXT, stage({ kind: "planning" }), "x", PREVIOUS);
    expect(prompt).toContain("do not do that stage's work here");
  });

  it("gives every stage kind a medium", () => {
    const kinds = [
      "planning",
      "implementation",
      "deployment",
      "test",
      "codeReview",
      "domainReview",
      "behaviourReview",
      "humanVerification",
      "assessment",
    ] as const;
    for (const kind of kinds) {
      expect(correctionMedium(kind).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("a correction declining to be a correction", () => {
  const PREVIOUS = "Built the grid with four stacked rows per Description Code.";

  it("asks for the marker rather than only for prose", () => {
    const prompt = correctionPrompt(CONTEXT, stage(), "Wrong layout.", PREVIOUS);
    expect(prompt).toContain("CORRECTION-DECLINED:");
  });

  it("says what happens if the decline is only described", () => {
    // The instruction has to name the consequence, because the failure is silent:
    // nothing looks wrong at the moment the stage is recorded as fixed.
    const prompt = correctionPrompt(CONTEXT, stage(), "Wrong layout.", PREVIOUS);
    expect(prompt).toContain("recorded as fixed");
  });

  it("still tells the session to narrow rather than improve", () => {
    // The decline route must not become an invitation to rebuild: that costs what a
    // re-run costs and invalidates the reviews that passed the rest.
    const prompt = correctionPrompt(CONTEXT, stage(), "Wrong layout.", PREVIOUS);
    expect(prompt).toContain("smallest change");
    expect(prompt).toContain(PREVIOUS);
  });

  it("reads the reason from the marker line", () => {
    const reply =
      "Tab 3 is one row per code with metrics as columns.\n" +
      "CORRECTION-DECLINED: the proc must return metrics as columns";
    expect(parseCorrectionDeclined(reply)).toBe(
      "the proc must return metrics as columns",
    );
  });

  it("ignores the words in prose", () => {
    expect(
      parseCorrectionDeclined("I declined the wider correction and fixed the cast."),
    ).toBeUndefined();
  });

  it("takes only the first, since a correction has one answer", () => {
    const reply =
      "CORRECTION-DECLINED: needs a new proc\nCORRECTION-DECLINED: and a new view";
    expect(parseCorrectionDeclined(reply)).toBe("needs a new proc");
  });

  it("strips the marker but keeps the reasoning", () => {
    const reply = "The shapes differ.\nCORRECTION-DECLINED: needs a new proc";
    expect(stripCorrectionDeclined(reply)).toBe("The shapes differ.");
  });

  it("comes off the report in readStageReply", () => {
    const reply = "The shapes differ.\nCORRECTION-DECLINED: needs a new proc";
    const read = readStageReply(reply);
    expect(read.correctionDeclined).toBe("needs a new proc");
    expect(read.report).toBe("The shapes differ.");
  });

  it("is not confused with a stage that could not start", () => {
    // BLOCKED means a prerequisite is missing and someone must supply it; this means
    // the output is wrong and the remedy is a re-run. Different remedies, so the
    // parsers must not answer for each other.
    const reply = "CORRECTION-DECLINED: needs a new proc";
    expect(parseBlocked(reply)).toBeUndefined();
    expect(parseCorrectionDeclined("BLOCKED: nothing committed")).toBeUndefined();
  });
});
