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

describe("documents a stage reached through the shell", () => {
  // The whole reason this module captured nothing for the first week it existed: it
  // read `pathsRead`, and a workbook is never opened with a file tool. Measured across
  // 17 pipelines -- 855 pathsRead entries, none document-shaped, against 70 commands
  // naming a workbook.
  it("reads a workbook out of the command that parsed it", () => {
    const found = discoveredDocuments({
      commands: [
        `cd /tmp/nmgb2799 && python3 -c "import openpyxl; openpyxl.load_workbook('Purchases vs Sales Mock-up 20.03.26.xlsx')"`,
      ],
    });
    expect(found.map((d) => d.path)).toEqual(["Purchases vs Sales Mock-up 20.03.26.xlsx"]);
  });

  it("reads one quoted because it contains spaces", () => {
    const found = discoveredDocuments({
      commands: [`unzip -o -q "../Purchases vs Sales Mock-up 20.03.26.xlsx"`],
    });
    expect(found).toHaveLength(1);
    // The quote must not survive into the path, or the extension reads as `xlsx"` and
    // every quoted workbook is silently dropped -- which is exactly what the first
    // version of this fix did.
    expect(found[0].path).not.toContain('"');
  });

  it("ignores a search pattern, which names no document", () => {
    expect(discoveredDocuments({ commands: [`find . -iname "*purchases*sales*.xlsx"`] })).toEqual(
      [],
    );
  });

  it("records one document once, however many ways a stage spelled it", () => {
    const found = discoveredDocuments({
      commands: [
        `unzip -q "/tmp/x/Mock-up.xlsx"`,
        `unzip -q "../Mock-up.xlsx"`,
        `python -c "openpyxl.load_workbook('Mock-up.xlsx')"`,
      ],
    });
    expect(found).toHaveLength(1);
  });

  // A command that only fetches says nothing about which of five attachments governs.
  it("ignores a download that nothing then opened", () => {
    expect(
      discoveredDocuments({ commands: [`curl -o report.xlsx https://example.test/report.xlsx`] }),
    ).toEqual([]);
  });
});
