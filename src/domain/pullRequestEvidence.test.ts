import { describe, expect, it } from "vitest";
import {
  missingPullRequestUrl,
  reportedPullRequestUrls,
} from "./pullRequestEvidence";
import { TaskStage } from "./taskPipeline";

function stage(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "rc-uat-promote",
    name: "Promote to UAT",
    kind: "deployment",
    status: "passed",
    intent: "promote",
    splittable: false,
    requiresApproval: false,
    subtasks: [],
    ...overrides,
  } as TaskStage;
}

function subtask(reply: string | undefined) {
  return {
    id: "rc-uat-promote-1",
    status: "done",
    startedAt: "2026-08-20T09:00:00.000Z",
    ...(reply === undefined ? {} : { reply }),
  } as TaskStage["subtasks"][number];
}

describe("reportedPullRequestUrls", () => {
  it("finds a Bitbucket pull request URL", () => {
    expect(
      reportedPullRequestUrls(
        "Opened https://bitbucket.org/QubeDataDevelopment/qubeautoapp/pull-requests/91 into UAT.",
      ),
    ).toEqual([
      "https://bitbucket.org/QubeDataDevelopment/qubeautoapp/pull-requests/91",
    ]);
  });

  it("finds GitHub, GitLab and Azure DevOps spellings", () => {
    const text = [
      "https://github.com/acme/app/pull/12",
      "https://gitlab.com/acme/app/-/merge_requests/34",
      "https://dev.azure.com/acme/app/_git/app/pullrequest/56",
    ].join("\n");
    expect(reportedPullRequestUrls(text)).toHaveLength(3);
  });

  it("strips the sentence's trailing punctuation but keeps the path", () => {
    expect(
      reportedPullRequestUrls("See https://github.com/acme/app/pull/12, then merge."),
    ).toEqual(["https://github.com/acme/app/pull/12"]);
  });

  it("reads a markdown link and a parenthesised URL", () => {
    expect(
      reportedPullRequestUrls(
        "[PR #7](https://github.com/acme/app/pull/7) (https://github.com/acme/app/pull/8)",
      ),
    ).toEqual(["https://github.com/acme/app/pull/7", "https://github.com/acme/app/pull/8"]);
  });

  it("deduplicates a URL quoted more than once", () => {
    const url = "https://bitbucket.org/acme/app/pull-requests/3";
    expect(reportedPullRequestUrls(`${url} ... and again ${url}`)).toEqual([url]);
  });

  // The RU-550 report: full of plausible detail, and no pull request anywhere in it.
  it("does not accept a branch, a repository or a ticket URL as a pull request", () => {
    const text = [
      "Pushed promote/RU-550-uat to origin.",
      "https://qubedatainnovation.atlassian.net/browse/RU-550",
      "https://bitbucket.org/QubeDataDevelopment/qubeautoapp/branch/promote/RU-550-uat",
      "https://bitbucket.org/QubeDataDevelopment/qubeautoapp.git",
    ].join("\n");
    expect(reportedPullRequestUrls(text)).toEqual([]);
  });

  // Segment matching, not substring: the whole point of keying on the path.
  it("does not match a repository merely named like a pull request", () => {
    expect(
      reportedPullRequestUrls("https://github.com/acme/pull-requests-tooling"),
    ).toEqual([]);
  });

  it("ignores text that is not a URL at all", () => {
    expect(reportedPullRequestUrls("opened a pull request into UAT")).toEqual([]);
  });
});

describe("missingPullRequestUrl", () => {
  it("is false for a stage that never declared it", () => {
    expect(
      missingPullRequestUrl(stage({ subtasks: [subtask("done, no link")] })),
    ).toBe(false);
  });

  it("holds a declaring stage whose reply carries no URL", () => {
    expect(
      missingPullRequestUrl(
        stage({
          requiresPullRequest: true,
          subtasks: [subtask("## Promote to UAT: done\n\nPushed promote/RU-550-uat.")],
        }),
      ),
    ).toBe(true);
  });

  it("passes a declaring stage that reported one", () => {
    expect(
      missingPullRequestUrl(
        stage({
          requiresPullRequest: true,
          subtasks: [subtask("Opened https://bitbucket.org/acme/app/pull-requests/91")],
        }),
      ),
    ).toBe(false);
  });

  // Absence of a reply is unmeasured, not zero — the rule stageUsage and
  // changedNothing both follow.
  it("does not hold a stage with nothing to read", () => {
    expect(missingPullRequestUrl(stage({ requiresPullRequest: true }))).toBe(false);
    expect(
      missingPullRequestUrl(
        stage({ requiresPullRequest: true, subtasks: [subtask(undefined)] }),
      ),
    ).toBe(false);
    expect(
      missingPullRequestUrl(
        stage({ requiresPullRequest: true, subtasks: [subtask("   ")] }),
      ),
    ).toBe(false);
  });

  // At least one, never a count: a split stage where one unit opened the pull request
  // and another reported on SQL is a correct run.
  it("passes when any subtask reported a URL", () => {
    expect(
      missingPullRequestUrl(
        stage({
          requiresPullRequest: true,
          subtasks: [
            subtask("Deployed the SQL to UAT."),
            subtask("Opened https://github.com/acme/app/pull/12"),
          ],
        }),
      ),
    ).toBe(false);
  });
});
