import { describe, expect, it } from "vitest";
import { VisualStudioService } from "./visualStudioService";
import { Logger } from "../logging/logger";

const silent: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** The real listing, trimmed: both solutions qubeautoapp tracks, plus a project. */
const FILES = [
  "QubeAutoApp.Data/QubeAutoApp.Data.sln",
  "QubeAutoApp.sln",
  "QubeAutoApp/QubeAutoApp.csproj",
];

describe("VisualStudioService.detect", () => {
  it("finds the shallowest solution", async () => {
    const service = new VisualStudioService(silent, async () => FILES);
    expect((await service.detect("C:/wt"))?.solution).toBe("QubeAutoApp.sln");
  });

  it("does not cache a listing that failed, so the next call tries again", async () => {
    // The bug: one failed `git ls-files` became a permanent "no solution here", and
    // "Open in Visual Studio" opened the folder from then on.
    let calls = 0;
    const service = new VisualStudioService(silent, async () => {
      calls++;
      if (calls === 1) throw new Error("git exploded");
      return FILES;
    });

    expect(await service.detect("C:/wt")).toBeUndefined();
    expect((await service.detect("C:/wt"))?.solution).toBe("QubeAutoApp.sln");
    expect(calls).toBe(2);
  });

  it("treats an empty listing as unscanned, not as a repository with no solution", async () => {
    // The same fault in different clothes: the injected lister reports a git failure as
    // an empty array, so it cannot tell the service which happened.
    let calls = 0;
    const service = new VisualStudioService(silent, async () => {
      calls++;
      return calls === 1 ? [] : FILES;
    });

    expect(await service.detect("C:/wt")).toBeUndefined();
    expect((await service.detect("C:/wt"))?.solution).toBe("QubeAutoApp.sln");
  });

  it("caches a genuine 'no solution' answer, since detection runs on every render", async () => {
    let calls = 0;
    const service = new VisualStudioService(silent, async () => {
      calls++;
      return ["README.md", "notes.txt"];
    });

    expect(await service.detect("C:/wt")).toBeUndefined();
    expect(await service.detect("C:/wt")).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("caches a found solution", async () => {
    let calls = 0;
    const service = new VisualStudioService(silent, async () => {
      calls++;
      return FILES;
    });

    await service.detect("C:/wt");
    await service.detect("C:/wt");
    expect(calls).toBe(1);
  });

  it("forgets a worktree on request", async () => {
    let calls = 0;
    const service = new VisualStudioService(silent, async () => {
      calls++;
      return FILES;
    });

    await service.detect("C:/wt");
    service.forget("C:/wt");
    await service.detect("C:/wt");
    expect(calls).toBe(2);
  });
});
