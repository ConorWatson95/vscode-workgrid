/**
 * Branch names from `for-each-ref --format=%(refname:short)`.
 *
 * Split out for the same reason `worktreeParser` is: it is the testable half, and a
 * test for it needs no repository.
 */
export function parseBranchNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));
}
