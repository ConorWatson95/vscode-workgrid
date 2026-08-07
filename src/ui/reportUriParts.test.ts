import { describe, expect, it } from "vitest";
import { decodeReportTarget, encodeReportTarget, reportFileName } from "./reportUriParts";

describe("report target round-trip", () => {
  it("carries a task and a stage", () => {
    const target = { taskId: "t1", stageId: "sc-deploy-dev-preview" };
    expect(decodeReportTarget(encodeReportTarget(target))).toEqual(target);
  });

  it("carries a task on its own", () => {
    expect(decodeReportTarget(encodeReportTarget({ taskId: "t1" }))).toEqual({ taskId: "t1" });
  });

  it("survives ids containing separators", () => {
    // A stage id comes from project config, so it is not guaranteed to be tame.
    const target = { taskId: "t&1=x", stageId: "a&b=c" };
    expect(decodeReportTarget(encodeReportTarget(target))).toEqual(target);
  });

  it("carries a second task for a comparison", () => {
    const target = { taskId: "t1", compareWith: "t2" };
    expect(decodeReportTarget(encodeReportTarget(target))).toEqual(target);
  });

  it("rejects a query with no task", () => {
    expect(decodeReportTarget("stage=s1")).toBeUndefined();
    expect(decodeReportTarget("")).toBeUndefined();
  });
});

describe("reportFileName", () => {
  it("names a stage report after the task and the stage", () => {
    expect(reportFileName("SC-123 widgets", "Deploy preview")).toBe(
      "SC-123 widgets — Deploy preview.md",
    );
  });

  it("names a task report after the task alone", () => {
    expect(reportFileName("SC-123 widgets")).toBe("SC-123 widgets.md");
  });

  it("drops characters a path cannot carry", () => {
    expect(reportFileName("feat/one: two?", "a*b")).toBe("feat one two — a b.md");
  });

  it("still produces a markdown name for an unnameable task", () => {
    // Otherwise the document has no extension and the preview refuses to render it.
    expect(reportFileName("///")).toBe("report.md");
  });
});
