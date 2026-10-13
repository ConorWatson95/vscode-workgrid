import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readArchivedHistories, writeArchivedHistory } from "./archivedHistoryFiles";

const dirs: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archived-history-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (taskId: string) => ({
  taskId,
  name: "Pyramid export",
  branchName: "feat/pyramid",
  archivedAt: "2026-10-13T08:00:00.000Z",
  sessions: [{ id: "s1", title: "Plan", mtimeMs: 1, file: "C:/history/t1/s1.jsonl" }],
});

describe("archived history files", () => {
  it("reads back what a removal outside VS Code wrote", () => {
    const base = scratch();
    writeArchivedHistory(base, entry("t1"));
    writeArchivedHistory(base, entry("t2"));
    expect(readArchivedHistories(base).map((e) => e.taskId).sort()).toEqual(["t1", "t2"]);
  });

  it("skips a directory with no record, or one it cannot read, rather than failing the list", () => {
    const base = scratch();
    writeArchivedHistory(base, entry("t1"));
    fs.mkdirSync(path.join(base, "transcripts-only"));
    fs.mkdirSync(path.join(base, "broken"));
    fs.writeFileSync(path.join(base, "broken", "archived.json"), "{ not json");
    expect(readArchivedHistories(base).map((e) => e.taskId)).toEqual(["t1"]);
  });

  it("reads nothing from an archive that does not exist yet", () => {
    expect(readArchivedHistories(path.join(scratch(), "missing"))).toEqual([]);
  });
});
