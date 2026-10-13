import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileReportOpener } from "./reportFiles";

describe("FileReportOpener", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the report as a page named for the task and hands that file to the launcher", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reports-"));
    dirs.push(dir);
    const launched: string[] = [];
    const opener = new FileReportOpener(path.join(dir, "reports"), (file) => launched.push(file), () => new Date(2026, 9, 13, 9, 30));
    const result = await opener.open({ name: "Pyramid export: NMGB-1/review", title: "Code review", markdown: "# Code review" });

    expect(result).toEqual({ ok: true, value: path.join(dir, "reports", "Pyramid-export-NMGB-1-review.html") });
    expect(launched).toEqual([path.join(dir, "reports", "Pyramid-export-NMGB-1-review.html")]);
    const page = fs.readFileSync(launched[0], "utf8");
    expect(page).toContain("<h1>Code review</h1>");
    expect(page).toContain("Written 13 Oct 2026, 09:30");
  });

  it("reports a file it could not write rather than launching nothing silently", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reports-"));
    dirs.push(dir);
    const blocker = path.join(dir, "reports");
    fs.writeFileSync(blocker, "a file where the directory should be");
    const launched: string[] = [];
    const result = await new FileReportOpener(blocker, (file) => launched.push(file)).open({ name: "t", title: "t", markdown: "" });
    expect(result.ok).toBe(false);
    expect(launched).toEqual([]);
  });
});
