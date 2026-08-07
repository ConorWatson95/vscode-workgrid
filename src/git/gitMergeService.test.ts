import { describe, expect, it } from "vitest";
import { GitMergeService } from "./gitMergeService";
import { GitClient, GitError } from "./gitClient";
import { ok, err } from "../utilities/result";

/**
 * A GitClient that records what it was asked to run and answers from a script.
 *
 * The arguments are the whole point of these tests: `-A` and `-u` are what decide
 * whether untracked files come along, and getting either wrong fails silently —
 * the commit succeeds, the merge proceeds, and the work is still sitting there.
 */
function fakeGit(answers: Record<string, "ok" | GitError> = {}) {
  const calls: string[][] = [];
  const client = {
    run: async (args: string[]) => {
      calls.push(args);
      const answer = answers[args[0]];
      if (answer && answer !== "ok") return err(answer);
      return ok({ stdout: "", stderr: "" });
    },
  } as unknown as GitClient;
  return { client, calls };
}

const failure = (stderr: string) => new GitError("failed", 1, stderr, ["git"], "");

describe("commitAll", () => {
  it("stages untracked files as well as modified ones", async () => {
    // The case that prompted this: a stage's untracked output. A commit that left it
    // behind would be worse than refusing — the merge proceeds and the work is still
    // uncommitted, with the user told it was dealt with.
    const { client, calls } = fakeGit();
    const result = await new GitMergeService(client).commitAll("/wt", "WIP: my task");

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(["add", "-A"]);
    expect(calls[1]).toEqual(["commit", "-m", "WIP: my task"]);
  });

  it("refuses an empty message rather than letting git prompt", async () => {
    // git would open an editor, which headless or in a status bar is a hang.
    const { client, calls } = fakeGit();
    const result = await new GitMergeService(client).commitAll("/wt", "   ");

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not commit when staging failed", async () => {
    const { client, calls } = fakeGit({ add: failure("permission denied") });
    const result = await new GitMergeService(client).commitAll("/wt", "msg");

    expect(result.ok).toBe(false);
    expect(calls.map((c) => c[0])).toEqual(["add"]);
  });
});

describe("stash", () => {
  it("includes untracked files, or the tree is not actually clean", async () => {
    const { client, calls } = fakeGit();
    await new GitMergeService(client).stash("/wt", "before merging");

    expect(calls[0]).toEqual(["stash", "push", "-u", "-m", "before merging"]);
  });
});

describe("stashPop", () => {
  it("says where the work still is when it cannot be restored", async () => {
    // The one outcome that leaves work somewhere the user did not put it. The stash
    // survives a failed pop, which is what makes it recoverable — so the message has
    // to say so rather than only that something went wrong.
    const { client } = fakeGit({ stash: failure("CONFLICT in src/app.ts") });
    const result = await new GitMergeService(client).stashPop("/wt");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("validation");
    if (result.error.kind !== "validation") return;
    expect(result.error.message).toMatch(/still safe in the stash/);
    expect(result.error.message).toMatch(/git stash pop/);
    expect(result.error.message).toMatch(/\/wt/);
  });

  it("succeeds quietly when the work comes back", async () => {
    const { client, calls } = fakeGit();
    const result = await new GitMergeService(client).stashPop("/wt");

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(["stash", "pop"]);
  });
});
