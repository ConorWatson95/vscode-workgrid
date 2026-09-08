import { describe, expect, it } from "vitest";
import {
  pullRequestBranches,
  pullRequestState,
  pullRequestAdvice,
  isOutstanding,
  PullRequestWait,
  shouldAskForPullRequest,
} from "./pullRequestWait";

// The link NMGB-2533's promote stage actually reported.
const REAL =
  "https://bitbucket.org/QubeDataDevelopment/qubeautoapp/pull-requests/new" +
  "?source=promote/nmgb-2533-navigator-uat-002&dest=UAT";

const wait = (over: Partial<PullRequestWait> = {}): PullRequestWait => ({
  url: REAL,
  source: "promote/nmgb-2533-navigator-uat-002",
  target: "UAT",
  stageId: "ec-uat-promote",
  at: "2026-09-07T10:00:00.000Z",
  ...over,
});

describe("pullRequestBranches", () => {
  it("reads Bitbucket's source and dest", () => {
    expect(pullRequestBranches(REAL)).toEqual({
      source: "promote/nmgb-2533-navigator-uat-002",
      target: "UAT",
    });
  });

  it("reads GitLab's and Azure's spelling", () => {
    expect(
      pullRequestBranches("https://host/x/pr/new?sourceBranch=a&targetBranch=b"),
    ).toEqual({ source: "a", target: "b" });
  });

  // A pull request that already exists carries an id, not branch names. Nothing local
  // can be checked against it, and guessing names out of the path would produce a
  // confident check against refs that do not exist.
  it("reads nothing from a link to an existing pull request", () => {
    expect(
      pullRequestBranches("https://bitbucket.org/org/repo/pull-requests/4417"),
    ).toEqual({});
  });

  it("reads nothing from a link with only one side", () => {
    expect(pullRequestBranches("https://host/pr/new?source=only")).toEqual({
      source: "only",
    });
  });
});

describe("pullRequestState", () => {
  it("is open when the branch is pushed and the work is not on the target", () => {
    expect(
      pullRequestState(wait(), { sourceOnRemote: true, commitsOnTarget: false }),
    ).toBe("open");
  });

  // NMGB-2533's first failure. The link was well-formed and origin had no such branch,
  // so it opened a page with nothing to compare -- and the remedy is the stage's, not
  // the operator's, which is why this is not folded into "open".
  it("is unpushed when the remote does not have the source branch", () => {
    expect(
      pullRequestState(wait(), { sourceOnRemote: false, commitsOnTarget: false }),
    ).toBe("unpushed");
  });

  it("is merged once the commits are on the target", () => {
    expect(
      pullRequestState(wait(), { sourceOnRemote: true, commitsOnTarget: true }),
    ).toBe("merged");
  });

  // Ordering, and it is load-bearing: a promote branch is routinely deleted once its
  // pull request merges, so checking unpushed first would tell somebody to push a
  // branch whose work has already landed. Both of NMGB-2533's promote branches were
  // merged and deleted remotely, which is what made this visible.
  it("is merged, not unpushed, when the branch was deleted after merging", () => {
    expect(
      pullRequestState(wait(), { sourceOnRemote: false, commitsOnTarget: true }),
    ).toBe("merged");
  });

  // Reported honestly rather than assumed merged. Assuming merged would switch the gate
  // off for any project whose stages report the pull request itself.
  it("is unknowable when the link names no branches", () => {
    expect(pullRequestState(wait({ source: undefined, target: undefined }), {})).toBe(
      "unknowable",
    );
  });

  it("is unknowable when only one branch is known", () => {
    expect(pullRequestState(wait({ target: undefined }), {})).toBe("unknowable");
  });

  // Absence of a git answer is not evidence of a merge. A fetch that failed must leave
  // the route waiting, not release it.
  it("is open when git could not say", () => {
    expect(pullRequestState(wait(), {})).toBe("open");
  });
});

describe("pullRequestAdvice", () => {
  it("says nothing about a merged pull request", () => {
    expect(pullRequestAdvice(wait(), "merged")).toBeUndefined();
    expect(isOutstanding("merged")).toBe(false);
  });

  // The rule the unscopable check follows: name the remedy, not the condition. And say
  // whose it is -- an unpushed branch is the stage's to fix and the operator can do
  // nothing about it.
  it("sends an unpushed branch back to the stage", () => {
    expect(pullRequestAdvice(wait(), "unpushed")).toContain("retry it");
  });

  // The half that stops the misattribution: the next gate's check WILL fail while the
  // pull request is open, and somebody reading that exit code needs to know it means
  // unmerged.
  it("warns that the next check reports unmerged, not unpromoted", () => {
    const advice = pullRequestAdvice(wait(), "open") ?? "";
    expect(advice).toContain("UNMERGED");
    expect(advice).toContain("UAT");
  });

  it("asks for an approval when nothing local can tell", () => {
    expect(pullRequestAdvice(wait(), "unknowable")).toContain("approve");
  });
});

describe("shouldAskForPullRequest", () => {
  const base = { requiresPullRequest: true, reportedNone: true, stageId: "promote" };

  // Observed twice on RenaultGB - MyRewards Summary, where rc-uat-promote and
  // rc-live-publish were both approved past the missing-URL hold. No URL means no wait,
  // which means nothing holds the route for the merge.
  it("asks when a stage that owed a pull request reported none", () => {
    expect(shouldAskForPullRequest(base)).toBe(true);
  });

  it("does not ask a stage that never owed one", () => {
    expect(
      shouldAskForPullRequest({ ...base, requiresPullRequest: false }),
    ).toBe(false);
  });

  it("does not ask when the stage reported one", () => {
    expect(shouldAskForPullRequest({ ...base, reportedNone: false })).toBe(false);
  });

  // The condition easiest to leave out. A wait may already exist -- recorded by the
  // runner, or by a previous approval -- and asking again would offer a second wait for
  // one pull request, which is the double-count recordPullRequests was corrected for.
  it("does not ask when this stage already has a wait", () => {
    expect(
      shouldAskForPullRequest({
        ...base,
        waits: [{ url: "u", stageId: "promote", at: "t0" }],
      }),
    ).toBe(false);
  });

  it("still asks when the only waits belong to another stage", () => {
    expect(
      shouldAskForPullRequest({
        ...base,
        waits: [{ url: "u", stageId: "elsewhere", at: "t0" }],
      }),
    ).toBe(true);
  });
});
