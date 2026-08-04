import { describe, expect, it } from "vitest";
import { changeRows, changeSummary, statusLabel } from "./changeList";
import { ChangedFile } from "../git/gitStatusService";

const file = (over: Partial<ChangedFile>): ChangedFile => ({
  path: "src/a.ts",
  status: "modified",
  ...over,
});

describe("changeRows", () => {
  it("reads a modified file's before side at the branch point", () => {
    const [row] = changeRows([file({})], "abc123");
    expect(row.before).toEqual({ kind: "blob", revision: "abc123", path: "src/a.ts" });
    expect(row.after).toEqual({ kind: "worktree", path: "src/a.ts" });
  });

  it("gives an added file an empty before side", () => {
    const [row] = changeRows([file({ status: "added" })], "abc123");
    expect(row.before).toEqual({ kind: "empty" });
    expect(row.after).toEqual({ kind: "worktree", path: "src/a.ts" });
  });

  it("gives a deleted file an empty after side", () => {
    const [row] = changeRows([file({ status: "deleted" })], "abc123");
    expect(row.before).toEqual({ kind: "blob", revision: "abc123", path: "src/a.ts" });
    expect(row.after).toEqual({ kind: "empty" });
  });

  it("reads a rename's before side at the old path", () => {
    // The new path does not exist at the branch point, so reading it there would
    // render the rename as an addition and lose the comparison entirely.
    const [row] = changeRows(
      [file({ path: "src/new.ts", status: "renamed", origin: "src/old.ts" })],
      "abc123",
    );
    expect(row.before).toEqual({ kind: "blob", revision: "abc123", path: "src/old.ts" });
    expect(row.after).toEqual({ kind: "worktree", path: "src/new.ts" });
  });
});

describe("statusLabel", () => {
  it("names the source of a rename", () => {
    expect(statusLabel(file({ status: "renamed", origin: "src/old.ts" }))).toBe(
      "renamed from src/old.ts",
    );
  });

  it("distinguishes an uncommitted new file", () => {
    expect(statusLabel(file({ status: "added", untracked: true }))).toBe(
      "added (not yet committed)",
    );
  });

  it("falls back to the bare status", () => {
    expect(statusLabel(file({}))).toBe("modified");
  });
});

describe("changeSummary", () => {
  it("counts each status", () => {
    expect(
      changeSummary([
        file({ path: "a", status: "added" }),
        file({ path: "b", status: "added" }),
        file({ path: "c", status: "deleted" }),
      ]),
    ).toBe("3 files · 2 added, 1 deleted");
  });

  it("uses the singular for one file", () => {
    expect(changeSummary([file({})])).toBe("1 file · 1 modified");
  });

  it("says so when there is nothing", () => {
    expect(changeSummary([])).toBe("no changes");
  });
});
