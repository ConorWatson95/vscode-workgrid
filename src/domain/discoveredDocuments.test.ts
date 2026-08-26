import { describe, expect, it } from "vitest";
import { discoveredDocuments, discoveredNote } from "./discoveredDocuments";

// String.raw throughout: these are verbatim Windows paths out of SubtaskActivity,
// and escaping them by hand is how the recorded value stops being the recorded value.
describe("discoveredDocuments", () => {
  it("picks the attachments the pyramid plan actually read, and no source files", () => {
    const found = discoveredDocuments({
      pathsRead: [
        String.raw`C:\Dev\worktrees\x\QubeAutoApp\Areas\TotalBusiness\Controllers\Bespoke\DealerReviewSummary\GB\DealerReviewSummaryController.cs`,
        String.raw`C:\Dev\worktrees\x\QubeAutoApp\Areas\TotalBusiness\Views\Bespoke\DealerReviewSummary\GB\Index.cshtml`,
        String.raw`C:\Users\Conor Watson\.claude\projects\C--Dev-qubeautoapp\memory\jira-attachment-helper.md`,
        String.raw`C:\Dev\qubeautoapp\image-20260824-083631.png`,
        String.raw`C:\Dev\qubeautoapp\image-20260818-091944.png`,
      ],
      commands: [
        String.raw`& "C:\Dev\qubeautoapp\tools\jira\Get-JiraAttachment.ps1" -IssueKey NMGB-2814 -Download`,
      ],
    });
    expect(found.map((d) => d.path)).toEqual([
      "C:/Dev/qubeautoapp/image-20260824-083631.png",
      "C:/Dev/qubeautoapp/image-20260818-091944.png",
    ]);
    expect(found[0].ticket).toBe("NMGB-2814");
  });

  it("finds a workbook wherever it landed, including the repository root", () => {
    const found = discoveredDocuments({
      pathsRead: ["C:/Dev/qubeautoapp/Pyramid- Wireframe Scope QUBE Master.xlsx"],
    });
    expect(found).toHaveLength(1);
    expect(found[0].ticket).toBeUndefined();
  });

  it("excludes the product's own images and build output", () => {
    expect(
      discoveredDocuments({
        pathsRead: [
          "C:/Dev/w/QubeAutoApp/assets/img/logo.png",
          "C:/Dev/w/QubeAutoApp/Content/themes/sprite.png",
          "C:/Dev/w/QubeAutoApp.Data/bin/Debug/report.pdf",
          "C:/Dev/w/node_modules/pkg/doc.pdf",
        ],
      }),
    ).toEqual([]);
  });

  it("excludes markdown and json, however governing they look", () => {
    expect(
      discoveredDocuments({ pathsRead: ["C:/Dev/w/docs/spec.md", "C:/Dev/w/wireframe.json"] }),
    ).toEqual([]);
  });

  it("deduplicates and caps, so a folder of screenshots cannot flood the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => `C:/Dev/r/shot-${i}.png`);
    expect(discoveredDocuments({ pathsRead: [...many, ...many] })).toHaveLength(6);
  });

  it("reads nothing from an activity with no paths", () => {
    expect(discoveredDocuments({})).toEqual([]);
    expect(discoveredDocuments({ pathsRead: [], commands: ["git status"] })).toEqual([]);
  });
});

describe("discoveredNote", () => {
  it("says how it got here and claims nothing about what it means", () => {
    expect(discoveredNote({ path: "a.xlsx", ticket: "NMGB-2814" }, "Plan")).toBe(
      'NMGB-2814 attachment, read by "Plan"',
    );
    expect(discoveredNote({ path: "a.xlsx" }, "Plan")).toBe('read by "Plan"');
  });
});
