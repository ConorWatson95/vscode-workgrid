/**
 * Whether a stage that promotes by pull request actually reported one.
 *
 * The tenth instance of the disease this codebase keeps closing one marker at a time:
 * a stage's reply claims an outcome the parser cannot check, so the route advances on
 * it. `DEFERRED`, `BLOCKED`, `CORRECTION-DECLINED`, the plan step, `changedNothing`,
 * `correctionChangedNothing` — each closed one case, and each was found the same way,
 * by something expensive happening downstream of a stage that had said "done".
 *
 * This one was found on RU-550. The UAT promote stage's intent says, in capitals,
 * *"open a pull request into UAT. REPORT THE PULL REQUEST URL in your report — a human
 * has to click it, and it is the one thing about this stage that cannot be
 * reconstructed afterwards from git."* The stage cherry-picked correctly, pushed the
 * promote branch, wrote a careful report headed `## Promote to UAT: done`, and never
 * opened the pull request. Nothing looked. The route carried on to a gate whose check
 * demanded the work be on UAT, where it could not be, because the merge it was waiting
 * for had no pull request to merge — and the operator's first news of any of it was an
 * exit code about commits, several stages and one working day later.
 *
 * The URL is the load-bearing artefact, which is what makes this checkable at all.
 * Everything else the stage does leaves a trace in git that can be reconstructed
 * afterwards; a pull request that was never opened leaves nothing, and a pull request
 * that was opened is a link somebody has to click. So "did the reply contain one" is
 * both the cheapest possible check and an exact statement of what the stage owed.
 *
 * Narrow in five ways, each load-bearing:
 *
 * - **Declared, never inferred from the kind.** A `deployment` stage is not
 *   necessarily a pull-request stage: `live-incident`'s reconcile stage cherry-picks
 *   onto the target directly and by design, and holding it for a URL it was never
 *   asked for is exactly how a check like this gets switched off. The route author
 *   says which stages promote by pull request, because only they know.
 * - **Held, never failed.** A live publish may legitimately produce fewer pull
 *   requests than there are targets — a change that does not apply to RenaultGB opens
 *   none for `LIVE_MultiMarket` — and a stage that says so is right. Holding costs one
 *   click; failing costs a re-run of a stage that did its job.
 * - **At least one, never a count.** The obvious refinement is "three live branches,
 *   three URLs", and it is wrong for the reason above: the correct number is a
 *   property of the change, not of the route, so a count fires on correct runs. One
 *   URL distinguishes "opened some" from "opened none", which is the distinction that
 *   actually failed.
 * - **Absence of a reply means unmeasured, not zero** — the rule `stageUsage`,
 *   `changedNothing` and `correctionChangedNothing` all follow. A stage that never ran,
 *   or ran before replies were recorded, tells us nothing about what it did.
 * - **Keyed on the path, not the host.** A pull request URL is recognised by carrying
 *   a pull-request path segment, so Bitbucket, GitHub, GitLab and Azure DevOps all
 *   work and no host list needs maintaining. A bare repository URL, a Jira link or a
 *   build log is not a pull request and must not satisfy this — the whole failure was
 *   a report full of plausible detail with the one required link absent.
 *
 * Pure and vscode-free.
 */

import { TaskStage } from "./taskPipeline";

/**
 * Path segments that mean "this URL addresses a pull request".
 *
 * Every forge spells it differently and none of them spells anything else this way.
 * Bitbucket and Azure DevOps use `pull-requests` and `pullrequest`, GitHub `pull` (and
 * `pulls` on a list), GitLab `merge_requests`. Matched as a path segment rather than a
 * substring, so a branch or repository *named* `pull` does not qualify.
 */
const PULL_REQUEST_SEGMENTS = [
  "pull-requests",
  "pullrequests",
  "pullrequest",
  "pull",
  "pulls",
  "merge_requests",
  "mergerequests",
];

/** Bare URLs in free text, including the markdown-link and parenthesised forms. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi;

/**
 * Every pull request URL in a stage's reply, in the order they appear, deduplicated.
 *
 * Returned rather than merely counted so the hold can say what it did find. A stage
 * that opened two of the three pull requests its plan required is a different
 * conversation from one that opened none, and the operator can only have that
 * conversation if the links are in front of them.
 */
export function reportedPullRequestUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    // Trailing punctuation belongs to the sentence, not the URL. Stripped after
    // matching rather than excluded from the character class, because a real path or
    // query can end in most of these and only a *trailing* one is prose.
    const url = match[0].replace(/[.,;:!?]+$/, "");
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    const segments = path.split("/").filter(Boolean).map((s) => s.toLowerCase());
    if (!segments.some((segment) => PULL_REQUEST_SEGMENTS.includes(segment))) continue;
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

/**
 * Whether a stage that owed a pull request URL settled without reporting one.
 *
 * Read from the replies rather than from activity, deliberately. A pull request can be
 * opened through the forge's web UI, an MCP tool, `gh`, or a push whose output prints
 * the create link — so there is no command or written path that reliably marks it, and
 * a check keyed on one would miss most of the ways it legitimately happens. What the
 * stage owes in every case is the same: the URL, in its report, where a human can
 * click it.
 */
export function missingPullRequestUrl(stage: TaskStage): boolean {
  if (!stage.requiresPullRequest) return false;
  const replies = stage.subtasks
    .map((subtask) => subtask.reply)
    .filter((reply): reply is string => typeof reply === "string" && reply.trim() !== "");
  // Nothing to read is not evidence of nothing reported.
  if (replies.length === 0) return false;
  return replies.every((reply) => reportedPullRequestUrls(reply).length === 0);
}

/** How the hold explains itself, in the stage's `blocked` line. */
export const MISSING_PULL_REQUEST_REASON =
  "this stage promotes by pull request and its report contains no pull request URL — " +
  "check one was actually opened before approving: the URL is the only part of this " +
  "stage that cannot be reconstructed from git, and the stage after it is a human " +
  "merging the pull request this one was supposed to open";
