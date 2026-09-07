/**
 * A pull request the route is waiting on, and what state it is actually in.
 *
 * `pullRequestEvidence` closed the case where a stage never opened one at all. This is
 * the case after it: the stage did its job, reported the link, and the route then had
 * nowhere to put the fact that a human still has to act. Two live failures on
 * NMGB-2533, and they are the same missing state seen from each end.
 *
 * **The URL satisfied the check while its branch existed nowhere.** `requiresPullRequest`
 * asks whether the reply carries a pull-request URL, and the promote stage reported a
 * perfectly well-formed *create* link — `?source=promote/nmgb-2533-navigator-uat-002&dest=UAT`
 * — for a branch that was never pushed. `origin` had no `promote/nmgb-2533*` at all. A
 * URL's shape was checkable; whether anything existed behind it was not.
 *
 * **And "unmerged" arrived as a check failure.** The next gate runs
 * `Test-WorkPromoted.ps1 -TargetBranch UAT`, which asks whether the commits are ON the
 * target — true only once somebody merges. So a correctly executed promotion failed its
 * own next gate with `4 of 12 commit(s) for NMGB-2533 are not on origin/UAT`, reported
 * against work that was complete and waiting. The route's own notes already say what
 * that exit code means — *unmerged, not unpromoted* — which is a comment compensating
 * for a state the model could not express.
 *
 * ## Answered from git, with no credentials
 *
 * The stage has no Bitbucket credentials and its intent says so in capitals, so the
 * obvious design — poll the API for `merged` — is unavailable and would need a token
 * the harness has no business holding. It is also unnecessary: *merged* means the
 * source's commits are on the target, which is a local question after a fetch. So the
 * gate needs no API, no token and no webhook, and it is true of GitHub, GitLab and
 * Azure DevOps without knowing which is in use.
 *
 * ## Three states, because three remedies
 *
 * Collapsing these to open/closed is the mistake, and `unpushed` is why: it looks
 * identical to `open` from the URL alone, and its remedy is the stage's — push the
 * branch — where `open`'s is the operator's. That distinction is the whole of the first
 * failure above.
 */

/** Where a pull request would take work, parsed from its own link. */
export interface PullRequestWait {
  /** The link, verbatim as the stage reported it. */
  url: string;
  /** The branch the pull request is from, when the link says. */
  source?: string;
  /** The branch it is into, when the link says. */
  target?: string;
  /** The stage that reported it. */
  stageId: string;
  /** When it was first recorded — what the operator's wait is measured from. */
  at: string;
  /**
   * When it was seen to be merged, or settled by hand.
   *
   * Written rather than recomputed, so `nextAction` stays pure: the state depends on
   * git, and an engine that had to ask git could not be a pure transition. The same
   * division a deferral already uses — the runner establishes the fact, the engine
   * reads the flag.
   *
   * Never cleared. A merge does not un-happen, and a wait that could reopen would hold
   * a route on a branch that has since been deleted.
   */
  mergedAt?: string;
}

export type PullRequestState =
  /**
   * The link names a source branch the remote does not have.
   *
   * The stage's own fix, and the reason this is not folded into `open`: a create link
   * for an unpushed branch opens a page with nothing to compare, so nobody can act on
   * it however long they wait.
   */
  | "unpushed"
  /** Somebody has to open and merge it. The operator's, and the point of all this. */
  | "open"
  /** The source's commits are on the target. Nothing is owed. */
  | "merged"
  /**
   * The link says nothing about which branches are involved.
   *
   * A pull request URL that is not a create link carries an id, not branch names, so
   * there is nothing local to check. Reported honestly rather than assumed merged —
   * assuming merged would switch the gate off for every project whose stages report the
   * pull request itself rather than the link that opens it.
   */
  | "unknowable";

/**
 * The branches a create link names.
 *
 * Deliberately only a **create** link, and only the query form. Bitbucket, GitHub and
 * GitLab all spell the create page differently, but each puts the two branches in the
 * query string, and that is the one form where the branch names are present at all.
 * Anything else parses to nothing and reports `unknowable`, which is the honest answer:
 * guessing branch names out of a path would produce a confident local check against
 * refs that do not exist.
 */
export function pullRequestBranches(url: string): { source?: string; target?: string } {
  const query = url.indexOf("?");
  if (query === -1) return {};
  const params = new URLSearchParams(url.slice(query + 1));
  // `dest` is Bitbucket's, `target`/`targetBranch` GitLab's and Azure's. Read in that
  // order and take the first that says anything, rather than merging: two of these
  // present with different values is a malformed link, and picking either is a guess.
  const source =
    params.get("source") ??
    params.get("sourceBranch") ??
    params.get("merge_request[source_branch]") ??
    undefined;
  const target =
    params.get("dest") ??
    params.get("targetBranch") ??
    params.get("merge_request[target_branch]") ??
    undefined;
  return {
    ...(source ? { source: source.trim() } : {}),
    ...(target ? { target: target.trim() } : {}),
  };
}

/**
 * What state a recorded wait is in, given what git says.
 *
 * The two facts are supplied rather than read, so this stays pure and so the caller
 * decides when to spend a fetch. Both are asked of the **remote** refs: a local branch
 * nobody pushed is exactly the first failure, and local knowledge of the target is
 * routinely behind.
 */
export function pullRequestState(
  wait: PullRequestWait,
  git: { sourceOnRemote?: boolean; commitsOnTarget?: boolean },
): PullRequestState {
  if (!wait.source || !wait.target) return "unknowable";
  // Merged is checked first, and that ordering is load-bearing: a promote branch is
  // routinely deleted once its pull request merges, which would otherwise read as
  // `unpushed` — the stage being told to push a branch whose work has already landed.
  if (git.commitsOnTarget) return "merged";
  if (git.sourceOnRemote === false) return "unpushed";
  return "open";
}

/** Whether a state still owes somebody something. */
export function isOutstanding(state: PullRequestState): boolean {
  return state !== "merged";
}

/**
 * What to tell the operator, naming the remedy rather than the condition.
 *
 * The rule the unscopable check follows: a promotion check reporting exit 4 *means*
 * "this work is not on the target branch", so a message that only restates the
 * condition sends somebody to diagnose a state the harness already knows.
 */
export function pullRequestAdvice(
  wait: PullRequestWait,
  state: PullRequestState,
): string | undefined {
  switch (state) {
    case "merged":
      return undefined;
    case "unpushed":
      return (
        `The pull request link for "${wait.source}" has no branch behind it — the ` +
        "remote does not have it, so the link opens a page with nothing to compare. " +
        "That is the promoting stage's to fix, not yours: retry it."
      );
    case "open":
      return (
        `Open and merge the pull request from "${wait.source}" into "${wait.target}". ` +
        "Nothing here can do it, and the check on the next stage will keep reporting " +
        "the work as not on the target until it is merged — which means UNMERGED, not " +
        "unpromoted."
      );
    case "unknowable":
      return (
        "A pull request was reported but its link does not say which branches are " +
        "involved, so nothing local can tell whether it has been merged. Merge it and " +
        "approve this stage."
      );
  }
}
