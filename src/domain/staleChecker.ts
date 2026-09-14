/**
 * The check that ran was the repository root's copy, and this branch has fixed it.
 *
 * `${repoRoot}` exists so a branch cannot choose the command that certifies it: the
 * command runs with the worktree as cwd, so a relative script path would resolve to
 * the branch's own copy, and the sharp version of that is a branch editing its checker
 * to `exit 0`. That rule is right and is not relaxed here.
 *
 * Its benign failure is staleness, and it costs an operator a morning each time. On
 * NMDESD-511 a SQL stage failed `Test-DeployedObjectMatchesRepo.ps1`, reporting that
 * `p_Overnight_Refresh` differed from the deployed body — true, and nothing to do with
 * the work: that object legitimately carries a different set of quarter blocks per
 * environment, so a whole-body compare can never pass for it. The branch had already
 * fixed exactly that, replacing the compare with a delta check, in a commit the base
 * branch had not yet taken. So the fix was 685 lines away in the same worktree, the
 * check that ran knew nothing about it, and the failure named the work.
 *
 * Nothing about the exit code is wrong and nothing here changes it — the stage still
 * fails, because the root's check is the authoritative one by construction. What was
 * missing is that the *reason* was invisible: the failure and its cause were both
 * derivable from facts the harness already holds, and were derived by hand instead.
 *
 * Deliberately an annotation, never a disposition. A false positive — a branch that
 * touched the script and whose work is also genuinely broken — costs a paragraph
 * beside a failure that was going to happen anyway; a false negative costs the
 * diagnosis by hand. There is no reading under which passing the stage would be right.
 *
 * Pure and vscode-free.
 */

/**
 * The repo-relative paths a command names through `${repoRoot}`.
 *
 * Read from the **declared** command rather than the substituted one, which is what
 * makes it exact: after substitution the root is an ordinary absolute path and telling
 * a script it names from an argument that merely mentions the repository would mean
 * guessing.
 *
 * A bare `${repoRoot}` with no path after it yields nothing. That form is the check's
 * *subject* — `-RepoRoot "${repoRoot}"` — not its script, and the two are independent
 * quantities that happen to share a placeholder.
 */
export function rootNamedPaths(declared: string): string[] {
  const found: string[] = [];
  const pattern = /\$\{repoRoot\}([^\s"';|&)]*)/g;
  for (const match of declared.matchAll(pattern)) {
    const tail = match[1].replace(/\\/g, "/").replace(/^\/+/, "");
    if (tail === "") continue;
    if (!found.includes(tail)) found.push(tail);
  }
  return found;
}

/**
 * Those of them this branch has changed — the scripts whose root copy is not the copy
 * this branch wrote.
 *
 * Exact paths only. A named directory is not treated as covering the files beneath it:
 * the directory form is the subject argument above, and widening to a prefix match
 * would report every stage of any branch that touched a tooling folder, which is how a
 * note like this stops being read.
 *
 * Case-insensitive with forward slashes, the comparison `worktreePath` reconciliation
 * already uses, because these paths come from git on Windows.
 */
export function staleCheckers(
  declared: string,
  changedPaths: readonly string[],
): string[] {
  const changed = new Set(
    changedPaths.map((path) => path.replace(/\\/g, "/").toLowerCase()),
  );
  return rootNamedPaths(declared).filter((path) =>
    changed.has(path.toLowerCase()),
  );
}

/**
 * What to tell the operator, given the scripts that are stale.
 *
 * Says the remedy, and says which remedy is not available: reaching for the worktree's
 * copy is the obvious move and it is the one thing that defeats the check. Naming the
 * base branch makes it an instruction rather than a principle.
 */
export function staleCheckerNote(
  stale: readonly string[],
  baseBranch: string,
): string | undefined {
  if (stale.length === 0) return undefined;
  const names = stale.map((path) => `\`${path}\``).join(", ");
  const one = stale.length === 1;
  return (
    `This check ran the ${baseBranch} copy of ${names}, and this branch has ` +
    `${one ? "changed that file" : "changed those files"}. ` +
    `The failure may be the older check rather than the work.\n\n` +
    `The root's copy is authoritative on purpose — a branch must not choose the ` +
    `command that certifies it — so running the worktree's copy is not the remedy. ` +
    `Land the change to ${one ? "it" : "them"} on ${baseBranch}, then re-run this stage.`
  );
}
