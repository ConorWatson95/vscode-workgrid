import { describe, expect, it } from "vitest";
import { mergePipelines, sameJson } from "./pipelineMerge";
import { TaskPipeline } from "./taskPipeline";

function pipeline(): TaskPipeline {
  return {
    routeId: "r",
    stages: [
      {
        id: "a",
        name: "Implement",
        kind: "implementation",
        status: "active",
        intent: "do it",
        splittable: false,
        requiresApproval: false,
        subtasks: [{ id: "a1", title: "Implement", prompt: "p", status: "active" }],
      },
      {
        id: "b",
        name: "Verify",
        kind: "humanVerification",
        status: "pending",
        intent: "check it",
        splittable: false,
        requiresApproval: true,
        subtasks: [],
        checklist: [
          { id: "c1", text: "one", checked: false },
          { id: "c2", text: "two", checked: false },
        ],
      },
    ],
    interventions: [{ kind: "approval", stageId: "x", at: "t0" }],
  } as unknown as TaskPipeline;
}

/** A structural edit, the way domain transitions make them: new objects on the path only. */
function edit(source: TaskPipeline, change: (copy: any) => void): TaskPipeline {
  const copy = JSON.parse(JSON.stringify(source));
  change(copy);
  return copy;
}

describe("mergePipelines", () => {
  it("returns the runner's pipeline untouched when nothing else wrote", () => {
    const base = pipeline();
    const ours = edit(base, (p) => (p.stages[0].status = "passed"));
    const merged = mergePipelines(base, ours, JSON.parse(JSON.stringify(base)));
    expect(merged.pipeline).toBe(ours);
    expect(merged.conflicts).toEqual([]);
  });

  it("keeps a tick made elsewhere while the runner finished its subtask", () => {
    const base = pipeline();
    const ours = edit(base, (p) => {
      p.stages[0].subtasks[0].status = "done";
      p.stages[0].subtasks[0].reply = "did it";
    });
    const theirs = edit(base, (p) => (p.stages[1].checklist[0].checked = true));

    const merged = mergePipelines(base, ours, theirs);

    expect(merged.conflicts).toEqual([]);
    expect(merged.pipeline.stages[0].subtasks[0]).toMatchObject({ status: "done", reply: "did it" });
    expect(merged.pipeline.stages[1].checklist?.map((c) => c.checked)).toEqual([true, false]);
  });

  it("keeps both sides' entries in an append-only ledger, the runner's first", () => {
    const base = pipeline();
    const ours = edit(base, (p) => p.interventions.push({ kind: "retry", stageId: "a", at: "t1" }));
    const theirs = edit(base, (p) =>
      p.interventions.push({ kind: "approval", stageId: "b", at: "t2" }),
    );

    const merged = mergePipelines(base, ours, theirs);

    expect(merged.conflicts).toEqual([]);
    expect(merged.pipeline.interventions?.map((i) => i.at)).toEqual(["t0", "t1", "t2"]);
  });

  it("keeps the runner's value where both changed one field, and names the path", () => {
    const base = pipeline();
    const ours = edit(base, (p) => (p.stages[1].status = "active"));
    const theirs = edit(base, (p) => (p.stages[1].status = "skipped"));

    const merged = mergePipelines(base, ours, theirs);

    expect(merged.pipeline.stages[1].status).toBe("active");
    expect(merged.conflicts).toEqual(["pipeline.stages[b].status"]);
  });

  it("lets a field the runner cleared stay cleared and one set elsewhere stay set", () => {
    const base = edit(pipeline(), (p) => (p.stages[0].blocked = "held"));
    const ours = edit(base, (p) => delete p.stages[0].blocked);
    const theirs = edit(base, (p) => (p.stages[1].blocked = "theirs"));

    const merged = mergePipelines(base, ours, theirs);

    expect(merged.pipeline.stages[0].blocked).toBeUndefined();
    expect(merged.pipeline.stages[1].blocked).toBe("theirs");
    expect(merged.conflicts).toEqual([]);
  });

  it("honours a removal on either side when the other left the item alone", () => {
    const base = edit(pipeline(), (p) =>
      p.stages[0].subtasks.push({ id: "a2", title: "fix", prompt: "p", status: "pending" }),
    );
    const ours = edit(base, (p) => p.stages[0].subtasks.pop());
    const theirs = edit(base, (p) => p.stages[1].checklist.shift());

    const merged = mergePipelines(base, ours, theirs);

    expect(merged.pipeline.stages[0].subtasks.map((s) => s.id)).toEqual(["a1"]);
    expect(merged.pipeline.stages[1].checklist?.map((c) => c.id)).toEqual(["c2"]);
    expect(merged.conflicts).toEqual([]);
  });

  it("reports an item removed on one side and changed on the other", () => {
    const base = pipeline();
    const ours = edit(base, (p) => p.stages[1].checklist.shift());
    const theirs = edit(base, (p) => (p.stages[1].checklist[0].checked = true));

    const merged = mergePipelines(base, ours, theirs);

    expect(merged.pipeline.stages[1].checklist?.map((c) => c.id)).toEqual(["c2"]);
    expect(merged.conflicts).toEqual(["pipeline.stages[b].checklist[c1]"]);
  });

  it("places an item added elsewhere after the one it followed there", () => {
    const base = pipeline();
    const ours = edit(base, (p) => (p.stages[0].status = "passed"));
    const theirs = edit(base, (p) =>
      p.stages.splice(1, 0, { id: "r", name: "Review", status: "pending", subtasks: [] }),
    );

    const merged = mergePipelines(base, ours, theirs);

    expect(merged.pipeline.stages.map((s) => s.id)).toEqual(["a", "r", "b"]);
    expect(merged.pipeline.stages[0].status).toBe("passed");
  });
});

describe("sameJson", () => {
  it("treats a property holding undefined as absent, as the state file will", () => {
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, { x: [2] }], [1, { x: [2] }])).toBe(true);
    expect(sameJson(undefined, null)).toBe(false);
  });
});
