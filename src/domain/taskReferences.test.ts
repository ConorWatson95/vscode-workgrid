import { describe, expect, it } from "vitest";
import { TaskReference, addDiscoveredReferences, addReference, normaliseReferences, referenceGuidance, removeReference } from "./taskReferences";

const AT = "2026-08-14T10:00:00.000Z";

describe("addReference", () => {
  it("adds to an absent list", () => {
    expect(addReference(undefined, { path: "docs/spec.xlsx" }, AT)).toEqual([
      { path: "docs/spec.xlsx", at: AT },
    ]);
  });

  it("keeps the note when one is given", () => {
    const [entry] = addReference(undefined, { path: "spec.xlsx", note: "tab 3" }, AT);
    expect(entry.note).toBe("tab 3");
  });

  it("omits an empty note rather than storing one", () => {
    const [entry] = addReference(undefined, { path: "spec.xlsx", note: "   " }, AT);
    expect(entry).not.toHaveProperty("note");
  });

  it("replaces an entry for the same document, so a note can be corrected", () => {
    const first = addReference(undefined, { path: "spec.xlsx", note: "tab 2" }, AT);
    const second = addReference(first, { path: "spec.xlsx", note: "tab 3" }, AT);
    expect(second).toHaveLength(1);
    expect(second[0].note).toBe("tab 3");
  });

  it("treats separator and case differences as the same document", () => {
    const first = addReference(undefined, { path: "docs/Spec.xlsx" }, AT);
    const second = addReference(first, { path: "docs\\spec.xlsx" }, AT);
    expect(second).toHaveLength(1);
  });

  it("does not mutate the list it was given", () => {
    const original = addReference(undefined, { path: "a.md" }, AT);
    const copy = [...original];
    addReference(original, { path: "b.md" }, AT);
    expect(original).toEqual(copy);
  });
});

describe("removeReference", () => {
  it("drops the named document and keeps the rest in order", () => {
    let refs = addReference(undefined, { path: "a.md" }, AT);
    refs = addReference(refs, { path: "b.md" }, AT);
    refs = addReference(refs, { path: "c.md" }, AT);
    expect(removeReference(refs, "b.md").map((r) => r.path)).toEqual(["a.md", "c.md"]);
  });

  it("is a no-op for a document that is not listed", () => {
    const refs = addReference(undefined, { path: "a.md" }, AT);
    expect(removeReference(refs, "zzz.md")).toHaveLength(1);
  });
});

describe("normaliseReferences", () => {
  it("returns undefined for anything that is not a list", () => {
    expect(normaliseReferences(undefined)).toBeUndefined();
    expect(normaliseReferences({ path: "a.md" })).toBeUndefined();
  });

  it("drops an entry with no path, which names no document", () => {
    expect(normaliseReferences([{ path: "  ", at: AT }, { path: "a.md", at: AT }])).toEqual([
      { path: "a.md", at: AT },
    ]);
  });

  it("returns undefined rather than an empty list when nothing survives", () => {
    expect(normaliseReferences([{ note: "tab 3" }])).toBeUndefined();
  });
});

describe("referenceGuidance", () => {
  it("says nothing at all when there are no references", () => {
    expect(referenceGuidance(undefined)).toEqual([]);
    expect(referenceGuidance([])).toEqual([]);
  });

  it("lists each document, with its note where there is one", () => {
    const refs: TaskReference[] = [
      { path: "docs/mockup.xlsx", note: "tab 3", at: AT },
      { path: "https://wiki/rules", at: AT },
    ];
    const text = referenceGuidance(refs).join("\n");
    expect(text).toContain("- docs/mockup.xlsx — tab 3");
    expect(text).toContain("- https://wiki/rules");
  });

  it("names the failure it exists to prevent: copying a neighbouring feature", () => {
    const text = referenceGuidance([{ path: "spec.xlsx", at: AT }]).join("\n");
    expect(text).toMatch(/template/i);
    expect(text).toMatch(/document decides/i);
  });

  it("tells a stage that cannot open a document to ask rather than substitute one", () => {
    const text = referenceGuidance([{ path: "spec.xlsx", at: AT }]).join("\n");
    expect(text).toMatch(/cannot open it, ask/i);
  });
});

describe("addDiscoveredReferences", () => {
  const AT = "2026-08-26T09:00:00.000Z";

  it("adds a found document marked discovered", () => {
    const next = addDiscoveredReferences(undefined, [{ path: "a.xlsx", note: "read by Plan" }], AT);
    expect(next).toEqual([
      { path: "a.xlsx", at: AT, note: "read by Plan", origin: "discovered" },
    ]);
  });

  it("never overwrites an operator entry, because the note is the part that matters", () => {
    const operator = [{ path: "wireframe.xlsx", note: "tab 3 — Data Detail", at: "2026-08-25" }];
    const next = addDiscoveredReferences(operator, [{ path: "WIREFRAME.XLSX", note: "read by Plan" }], AT);
    expect(next).toEqual(operator);
  });

  it("does not add the same document twice across stages", () => {
    const first = addDiscoveredReferences(undefined, [{ path: "C:/r/a.png" }], AT);
    const second = addDiscoveredReferences(first, [{ path: "C:\\r\\A.PNG" }], AT);
    expect(second).toHaveLength(1);
  });

  it("keeps operator and discovered entries side by side", () => {
    const next = addDiscoveredReferences(
      [{ path: "spec.xlsx", at: "2026-08-25" }],
      [{ path: "shot.png" }],
      AT,
    );
    expect(next.map((r) => [r.path, r.origin])).toEqual([
      ["spec.xlsx", undefined],
      ["shot.png", "discovered"],
    ]);
  });
});

describe("referenceGuidance with both tiers", () => {
  it("states governing documents as deciding and found ones as available only", () => {
    const text = referenceGuidance([
      { path: "spec.xlsx", note: "tab 3", at: AT_ANY },
      { path: "shot.png", at: AT_ANY, origin: "discovered" },
    ]).join("\n");
    expect(text).toContain("These documents govern this task");
    expect(text).toContain("spec.xlsx — tab 3");
    expect(text).toContain("available rather than authoritative");
    expect(text).toContain("do not go looking for them again");
    // The authority sentence must attach to the governing list only.
    expect(text.indexOf("the document decides")).toBeLessThan(
      text.indexOf("available rather than authoritative"),
    );
  });

  it("omits the governing heading entirely when every document was discovered", () => {
    const text = referenceGuidance([{ path: "shot.png", at: AT_ANY, origin: "discovered" }]).join("\n");
    expect(text).not.toContain("govern this task");
    expect(text).toContain("available rather than authoritative");
  });

  it("reads a pre-origin reference exactly as before", () => {
    const text = referenceGuidance([{ path: "spec.xlsx", at: AT_ANY }]).join("\n");
    expect(text).toContain("These documents govern this task");
    expect(text).not.toContain("available rather than authoritative");
  });
});

const AT_ANY = "2026-08-26T09:00:00.000Z";
