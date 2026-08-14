/**
 * Ordering for the base-branch picker.
 *
 * A base branch is what every later stage diffs against, so it is asked for rather
 * than guessed — but typing it from memory is how it comes out wrong, and a wrong
 * base makes every review read the wrong set of changes. Listing the branches that
 * actually exist turns the question into a choice.
 *
 * The default goes first because it is right most of the time, and the long tail is
 * alphabetical rather than in git's ref order, which is alphabetical per-namespace
 * and reads as unsorted once prefixes are in play.
 */
export function orderBaseBranchChoices(
  branches: readonly string[],
  defaultBase: string,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (branch: string) => {
    const name = branch.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
  };

  // The default is offered even when it names no local branch. It may be `HEAD`, or a
  // branch that exists only on the remote, and dropping it would silently replace the
  // configured answer with a different one.
  add(defaultBase);
  for (const branch of [...branches].sort((a, b) => a.localeCompare(b))) add(branch);
  return ordered;
}
