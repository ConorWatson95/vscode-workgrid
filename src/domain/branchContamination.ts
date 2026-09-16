/**
 * Work in this branch's diff that belongs to somebody else's ticket.
 *
 * On NMGB-2822 the worktree's `sp_TradeCampaigns.sql` carried 52 changed lines, of
 * which 3 were the task's own: the rest were another ticket's campaign-conflict engine,
 * referencing two columns no baseline table has and that only NMGB-2832's migration
 * creates. The branch could therefore never deploy — a missing column on an existing
 * table fails at CREATE — and the task sat stopped for six days while the diagnosis was
 * made by hand: a grep for the columns, a look in another project's README, and finally
 * `git log --all -S` to find the commit it had come from.
 *
 * Every input to that diagnosis is a fact the harness already holds or can get in one
 * git call, which is what makes this admissible at all.
 *
 * **The conjunction is the whole design, and the naive half was measured and rejected.**
 * The obvious check is "a changed file no stage on this task is recorded as writing",
 * since `SubtaskActivity.pathsWritten` is kept verbatim. Measured on the live case that
 * is **1 true positive and 2 false**: the task changed four procedures and the activity
 * watcher recorded one, because the other three were written through a shell heredoc,
 * which records no path at all — the same gap that made `rc-plan`'s plan document
 * invisible to `changedNothing`. A flag firing on three files out of four is the noise
 * that teaches an operator to stop reading it.
 *
 * So the unattributed set is the **filter** — it decides which files are worth a git
 * call, and most changes have none — and the **confirmation** is that the added content
 * exists in a commit outside this branch's history. That second half is what turns a
 * suspicion into a diagnosis: it names the ticket the work came from, which is the
 * sentence the operator otherwise has to go and write themselves.
 *
 * Pure and vscode-free; the git query is injected by the caller.
 */

/** A commit outside this branch's history that already carries one of its added lines. */
export interface ForeignCommit {
  sha: string;
  subject: string;
}

export interface Contamination {
  /** Repo-relative, spelled as the changed-paths source spells it. */
  path: string;
  commits: ForeignCommit[];
}

/**
 * Changed paths that no subtask of this task recorded writing.
 *
 * A filter, never a finding — see the header. Comparison is case-insensitive on forward
 * slashes, the normalisation `worktreePath` reconciliation already uses, because the
 * activity watcher records whatever spelling the tool used and a path lost to a
 * separator would put a file into the checked set for no reason.
 *
 * `pathsWritten` entries are routinely absolute (the session's cwd is the worktree) and
 * changed paths are repo-relative, so a written path counts as covering a changed one
 * when it *ends with* it on a segment boundary. Matching the other way round, or on a
 * bare basename, would let a file called `README.md` anywhere in the tree attribute
 * every other `README.md` in the diff.
 */
export function unattributedPaths(
  changedPaths: readonly string[],
  pathsWritten: readonly string[],
): string[] {
  const written = pathsWritten.map(normalise).filter((path) => path.length > 0);
  return changedPaths.filter((changed) => {
    const target = normalise(changed);
    if (!target) return false;
    return !written.some(
      (path) => path === target || path.endsWith(`/${target}`),
    );
  });
}

function normalise(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
}

/**
 * Added lines worth searching other branches for.
 *
 * The search is `git log -S <line>`, so a line that appears in half the repository
 * answers nothing and costs a full history scan. Short lines, block delimiters and bare
 * keywords are dropped for that reason rather than to be tidy.
 *
 * Comments are deliberately **kept**. The instinct is to drop them as not-really-code,
 * but a contaminating change brings its own comments with it — NMGB-2832's engine
 * rewrite left `-- Love2Shop overlap suppression is handled inline` in the file — and a
 * comment is often the most distinctive line in a hunk. A line the task wrote itself
 * simply matches no foreign commit, so there is no cost to including it.
 */
export function distinctiveLines(addedLines: readonly string[], max = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addedLines) {
    const line = raw.trim();
    // Long enough to be distinctive, and not a delimiter or a bare keyword. 30 is
    // chosen against the live case: the shortest line that would have identified
    // NMGB-2832 is `IF @ConflictGroupId IS NOT NULL` at 31.
    if (line.length < 30) continue;
    if (!/[a-zA-Z]{3}/.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The note, or `undefined` when nothing was confirmed.
 *
 * Says which commit the work came from, because that is the diagnosis rather than a
 * hint — an operator told only "this file looks wrong" still has the whole
 * investigation in front of them, and it is the investigation that cost the six days.
 *
 * It states the remedy as a question rather than an instruction. Restoring the file is
 * usually right and is not always: a branch may carry another ticket's commit
 * deliberately, and the harness cannot tell that from the diff. Naming what it found
 * and letting the operator rule on it is the line `stagedEnvironmentPaths` already
 * draws — the paths are named, which of them belongs is not.
 */
export function contaminationNote(found: readonly Contamination[]): string | undefined {
  if (found.length === 0) return undefined;

  const lines = found.map((item) => {
    const commits = item.commits
      .map((commit) => `${commit.sha.slice(0, 9)} ${commit.subject}`)
      .join("; ");
    return `- \`${item.path}\` — content already committed elsewhere: ${commits}`;
  });

  return (
    `${found.length === 1 ? "A file" : `${found.length} files`} in this branch's diff ` +
    "carries changes that are already committed on another branch, and that no stage " +
    "of this task is recorded as writing:\n\n" +
    `${lines.join("\n")}\n\n` +
    "That usually means another ticket's work has been picked up into this worktree — " +
    "which makes this branch undeployable on its own if that work depends on schema it " +
    "brought with it. Restore the file to its state at the merge base and re-apply only " +
    "this task's change, or say why the other ticket's work belongs here."
  );
}
