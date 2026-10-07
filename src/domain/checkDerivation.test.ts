import { describe, expect, it } from "vitest";
import {
  applyItemAccounts,
  checklistToImplement,
  checksStageFor,
  delegatedAuthoring,
  gateReadsUpstreamChecklist,
  itemAccountInstruction,
  parseItemAccounts,
  unaccountedItemsReason,
} from "./checkDerivation";
import { checkAuthoringSkipped } from "./checkAuthoring";
import { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";

const MANIFEST = ".taskworkspaces/site-checks.json";

function item(over: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return { text: `claim ${over.id}`, checked: false, raisedByStage: "qa", ...over };
}

function stage(over: Partial<TaskStage> & { id: string; kind: TaskStage["kind"] }): TaskStage {
  return {
    name: over.id,
    status: "pending",
    intent: "",
    gate: "approval",
    subtasks: [],
    ...over,
  } as TaskStage;
}

/** implement → qa list → write checks → gate, the shape the routes now declare. */
function threeStage(items: ChecklistItem[] = [item({ id: "qa-c1" }), item({ id: "qa-c2" })]) {
  return {
    routeId: "r",
    stages: [
      stage({ id: "impl", kind: "implementation", status: "passed" }),
      stage({ id: "qa", kind: "behaviourReview", status: "passed", checklist: items }),
      stage({ id: "checks", kind: "implementation", status: "active", checkManifest: MANIFEST }),
      stage({ id: "gate", kind: "humanVerification", checkManifest: MANIFEST, checkResults: "r.json" }),
    ],
  } as TaskPipeline;
}

describe("delegatedAuthoring", () => {
  it("finds the checks stage and the review ahead of it", () => {
    expect(delegatedAuthoring(threeStage(), "gate")).toEqual({
      checksStageId: "checks",
      writerStageId: "qa",
    });
  });

  it("matches the manifest however the path is spelled", () => {
    const p = threeStage();
    p.stages[2] = { ...p.stages[2], checkManifest: ".TaskWorkspaces\\site-checks.json" };
    expect(delegatedAuthoring(p, "gate")?.checksStageId).toBe("checks");
  });

  it("is absent where no earlier stage declares the gate's manifest", () => {
    const p = threeStage();
    p.stages[2] = { ...p.stages[2], checkManifest: undefined };
    expect(delegatedAuthoring(p, "gate")).toBeUndefined();
    expect(gateReadsUpstreamChecklist(p, "gate")).toBe(false);
  });

  // The shape that produced the defect: the gate must go on writing its own list, or
  // nothing would write one at all.
  it("leaves the gate writing its list where nothing writes one ahead of the checks", () => {
    const p = threeStage();
    p.stages.splice(1, 1);
    expect(delegatedAuthoring(p, "gate")).toEqual({ checksStageId: "checks" });
    expect(gateReadsUpstreamChecklist(p, "gate")).toBe(false);
  });

  it("does not count a review placed after the checks stage", () => {
    const p = threeStage();
    const [qa] = p.stages.splice(1, 1);
    p.stages.splice(2, 0, qa);
    expect(delegatedAuthoring(p, "gate")?.writerStageId).toBeUndefined();
  });

  // report-change: a DEV-site sign-off shares the local gate's manifest, and nothing
  // upstream writes its list.
  it("leaves a later gate sharing the manifest to author its own", () => {
    const p = threeStage();
    p.stages.push(stage({ id: "site", kind: "humanVerification", checkManifest: MANIFEST }));
    expect(delegatedAuthoring(p, "site")).toBeUndefined();
    expect(gateReadsUpstreamChecklist(p, "gate")).toBe(true);
  });

  it("makes the gate a reader where both exist", () => {
    expect(gateReadsUpstreamChecklist(threeStage(), "gate")).toBe(true);
  });
});

describe("checksStageFor", () => {
  it("names the stage that implements the review's list", () => {
    expect(checksStageFor(threeStage(), "qa")?.id).toBe("checks");
  });

  it("is absent for a review with no checks stage after it", () => {
    const p = threeStage();
    p.stages[2] = { ...p.stages[2], checkManifest: undefined };
    expect(checksStageFor(p, "qa")).toBeUndefined();
  });
});

describe("checklistToImplement", () => {
  it("hands the checks stage every open item the gate answers for", () => {
    const handed = checklistToImplement(threeStage(), "checks");
    expect(handed?.gate.id).toBe("gate");
    expect(handed?.items.map((i) => i.id)).toEqual(["qa-c1", "qa-c2"]);
  });

  it("leaves out ticked, withdrawn and action items", () => {
    const p = threeStage([
      item({ id: "qa-c1", checked: true }),
      item({ id: "qa-c2", retired: { reason: "x", at: "t" } } as Partial<ChecklistItem> & { id: string }),
      item({ id: "qa-c3", kind: "action" }),
      item({ id: "qa-c4" }),
    ]);
    expect(checklistToImplement(p, "checks")?.items.map((i) => i.id)).toEqual(["qa-c4"]);
  });

  it("keeps an item already naming a check, so a re-run can see it", () => {
    const p = threeStage([item({ id: "qa-c1", coveredBy: "old" })]);
    expect(checklistToImplement(p, "checks")?.items[0].coveredBy).toBe("old");
  });

  it("is absent with nothing to implement, leaving the prompt unchanged", () => {
    expect(checklistToImplement(threeStage([]), "checks")).toBeUndefined();
  });

  it("is absent once the gate has passed", () => {
    const p = threeStage();
    p.stages[3] = { ...p.stages[3], status: "passed" };
    expect(checklistToImplement(p, "checks")).toBeUndefined();
  });

  it("is absent for a stage that is not the gate's checks stage", () => {
    expect(checklistToImplement(threeStage(), "impl")).toBeUndefined();
  });
});

describe("parseItemAccounts", () => {
  it("reads a check and a gap", () => {
    const accounts = parseItemAccounts(
      [
        "Report text.",
        "ITEM qa-c1: check crm-label-reads-new-text",
        "ITEM qa-c2: gap — no step compares two responses",
      ].join("\n"),
    );
    expect(accounts).toEqual([
      { itemId: "qa-c1", check: "crm-label-reads-new-text", line: "ITEM qa-c1: check crm-label-reads-new-text" },
      {
        itemId: "qa-c2",
        gap: "no step compares two responses",
        line: "ITEM qa-c2: gap — no step compares two responses",
      },
    ]);
  });

  it("tolerates markdown around the marker and backticks around ids", () => {
    const accounts = parseItemAccounts("- **ITEM `qa-c1`: check `the-check`**\n### ITEM qa-c2: gap: x");
    expect(accounts.map((a) => [a.itemId, a.check ?? a.gap])).toEqual([
      ["qa-c1", "the-check"],
      ["qa-c2", "x"],
    ]);
  });

  it("does not read the word in prose", () => {
    expect(parseItemAccounts("Each ITEM qa-c1: check it later, said the review.")).toEqual([]);
  });

  it("drops a state that is neither word, so the item reads as unaccounted", () => {
    expect(parseItemAccounts("ITEM qa-c1: done")).toEqual([]);
  });

  it("takes the later line where the stage revised its answer", () => {
    const accounts = parseItemAccounts("ITEM qa-c1: gap — none yet\nITEM qa-c1: check wrote-it");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].check).toBe("wrote-it");
  });
});

describe("applyItemAccounts", () => {
  const manifest = '{"checks":[{"id":"the-check"}]}';

  it("attaches a check that is in the manifest, without ticking", () => {
    const p = threeStage();
    const handed = checklistToImplement(p, "checks")!;
    const applied = applyItemAccounts(
      p,
      handed.items,
      parseItemAccounts("ITEM qa-c1: check the-check\nITEM qa-c2: gap — missing step"),
      manifest,
    );
    const qa = applied.pipeline.stages.find((s) => s.id === "qa")!;
    expect(qa.checklist![0]).toMatchObject({ coveredBy: "the-check", checked: false });
    expect(applied.gaps.map((g) => g.reason)).toEqual(["missing step"]);
    expect(applied.unaccounted).toEqual([]);
  });

  it("refuses a check the manifest does not contain, leaving the item unaccounted", () => {
    const p = threeStage([item({ id: "qa-c1" })]);
    const applied = applyItemAccounts(
      p,
      checklistToImplement(p, "checks")!.items,
      parseItemAccounts("ITEM qa-c1: check invented"),
      manifest,
    );
    expect(applied.ignored).toEqual([{ line: "ITEM qa-c1: check invented", why: "no such check" }]);
    expect(applied.unaccounted.map((i) => i.id)).toEqual(["qa-c1"]);
  });

  it("refuses an id it was not handed", () => {
    const p = threeStage([item({ id: "qa-c1" })]);
    const applied = applyItemAccounts(
      p,
      checklistToImplement(p, "checks")!.items,
      parseItemAccounts("ITEM other-c9: check the-check\nITEM qa-c1: gap — x"),
      manifest,
    );
    expect(applied.ignored[0].why).toBe("no such item");
  });

  it("accepts the claim when the manifest could not be read", () => {
    // A claim naming a missing check holds the gate on its own account, so refusing
    // here would only lose a correct claim.
    const p = threeStage([item({ id: "qa-c1" })]);
    const applied = applyItemAccounts(
      p,
      checklistToImplement(p, "checks")!.items,
      parseItemAccounts("ITEM qa-c1: check anything"),
      undefined,
    );
    expect(applied.attached).toHaveLength(1);
  });

  it("re-attributes an unticked item to the check that now implements it", () => {
    const p = threeStage([item({ id: "qa-c1", coveredBy: "old" })]);
    const applied = applyItemAccounts(
      p,
      checklistToImplement(p, "checks")!.items,
      parseItemAccounts("ITEM qa-c1: check the-check"),
      manifest,
    );
    expect(applied.pipeline.stages[1].checklist![0].coveredBy).toBe("the-check");
  });

  it("names every item the stage said nothing about", () => {
    const p = threeStage();
    const applied = applyItemAccounts(p, checklistToImplement(p, "checks")!.items, [], manifest);
    expect(applied.unaccounted.map((i) => i.id)).toEqual(["qa-c1", "qa-c2"]);
    expect(unaccountedItemsReason(applied.unaccounted)).toMatch(/qa-c1, qa-c2/);
  });

  it("never mutates its input", () => {
    const p = threeStage();
    const before = JSON.stringify(p);
    applyItemAccounts(p, checklistToImplement(p, "checks")!.items, parseItemAccounts("ITEM qa-c1: check the-check"), manifest);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("itemAccountInstruction", () => {
  it("lists every id and states both answers", () => {
    const text = itemAccountInstruction(checklistToImplement(threeStage(), "checks")!);
    expect(text).toContain("qa-c1: claim qa-c1");
    expect(text).toContain("ITEM <item id>: check <check id>");
    expect(text).toContain("ITEM <item id>: gap");
  });
});

// The hold that was on the gate moves to the checks stage, which is the one that owes it.
describe("checkAuthoringSkipped with authoring upstream", () => {
  it("does not hold a gate whose checks a stage before it writes", () => {
    const p = threeStage();
    p.stages[3] = { ...p.stages[3], status: "awaiting-approval" };
    expect(checkAuthoringSkipped(p, "gate", { before: "{}", after: "{}" })).toBeUndefined();
  });
});
