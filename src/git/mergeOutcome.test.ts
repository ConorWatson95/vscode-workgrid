import { describe, expect, it } from "vitest";
import {
  classifyMerge,
  leavesMergeInProgress,
  parseConflictPaths,
  parseOverwrittenPaths,
} from "./mergeOutcome";

const out = (stdout: string, stderr = "", exitCode = 0) => ({
  exitCode,
  stdout,
  stderr,
});

describe("classifyMerge", () => {
  it("reports an unchanged tree as up-to-date", () => {
    expect(classifyMerge(out("Already up to date.\n"))).toEqual({
      kind: "up-to-date",
    });
  });

  it("accepts git's older hyphenated wording", () => {
    expect(classifyMerge(out("Already up-to-date.\n")).kind).toBe("up-to-date");
  });

  it("distinguishes a fast-forward from a merge commit", () => {
    const ff = classifyMerge(
      out("Updating a1b2c3d..e4f5a6b\nFast-forward\n tools/sql/x.ps1 | 12 ++++\n"),
    );
    expect(ff).toEqual({ kind: "merged", fastForward: true });

    const commit = classifyMerge(out("Merge made by the 'ort' strategy.\n"));
    expect(commit).toEqual({ kind: "merged", fastForward: false });
  });

  it("reads conflicting paths from stdout, where git puts them", () => {
    const outcome = classifyMerge(
      out(
        "Auto-merging src/a.ts\n" +
          "CONFLICT (content): Merge conflict in src/a.ts\n" +
          "Automatic merge failed; fix conflicts and then commit the result.\n",
        "",
        1,
      ),
    );
    expect(outcome).toEqual({ kind: "conflicted", paths: ["src/a.ts"] });
  });

  it("treats a refusal to start as blocked, not conflicted", () => {
    // The two need different handling: there is no merge in progress here, so
    // calling `--abort` would fail and mask the real problem.
    const outcome = classifyMerge(
      out(
        "",
        "error: Your local changes to the following files would be overwritten by merge:\n" +
          "\tsrc/a.ts\n" +
          "\tsrc/b.ts\n" +
          "Please commit your changes or stash them before you merge.\n" +
          "Aborting\n",
        1,
      ),
    );
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") return;
    expect(outcome.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("falls back to git's message for anything else", () => {
    const outcome = classifyMerge(
      out("", "fatal: not something we can merge: dev\n", 128),
    );
    expect(outcome).toEqual({
      kind: "failed",
      message: "fatal: not something we can merge: dev",
    });
  });

  it("names the exit code when git said nothing at all", () => {
    const outcome = classifyMerge(out("", "", 1));
    expect(outcome).toEqual({ kind: "failed", message: "git merge exited 1" });
  });
});

describe("parseConflictPaths", () => {
  it("handles the modify/delete spelling, which puts the path first", () => {
    expect(
      parseConflictPaths(
        "CONFLICT (modify/delete): src/gone.ts deleted in dev and modified in HEAD.\n",
      ),
    ).toEqual(["src/gone.ts"]);
  });

  it("deduplicates a path git mentions twice", () => {
    expect(
      parseConflictPaths(
        "CONFLICT (content): Merge conflict in src/a.ts\n" +
          "CONFLICT (content): Merge conflict in src/a.ts\n",
      ),
    ).toEqual(["src/a.ts"]);
  });

  it("ignores lines that merely talk about conflicts", () => {
    expect(
      parseConflictPaths("Automatic merge failed; fix conflicts and then commit.\n"),
    ).toEqual([]);
  });

  it("keeps paths containing spaces intact", () => {
    expect(
      parseConflictPaths("CONFLICT (content): Merge conflict in src/my file.ts\n"),
    ).toEqual(["src/my file.ts"]);
  });
});

describe("parseOverwrittenPaths", () => {
  it("stops at the flush-left advice rather than collecting it as a file", () => {
    expect(
      parseOverwrittenPaths(
        "error: Your local changes to the following files would be overwritten by merge:\n" +
          "\tsrc/a.ts\n" +
          "Please commit your changes or stash them before you merge.\n",
      ),
    ).toEqual(["src/a.ts"]);
  });

  it("returns nothing when the heading is absent", () => {
    expect(parseOverwrittenPaths("CONFLICT (content): Merge conflict in a.ts")).toEqual(
      [],
    );
  });
});

describe("leavesMergeInProgress", () => {
  it("is true only for a conflicted merge", () => {
    expect(leavesMergeInProgress({ kind: "conflicted", paths: [] })).toBe(true);
    expect(
      leavesMergeInProgress({ kind: "blocked", paths: [], message: "x" }),
    ).toBe(false);
    expect(leavesMergeInProgress({ kind: "merged", fastForward: false })).toBe(false);
    expect(leavesMergeInProgress({ kind: "up-to-date" })).toBe(false);
    expect(leavesMergeInProgress({ kind: "failed", message: "x" })).toBe(false);
  });
});
