/**
 * Whether a stage can be shown to have taken a worktree, rather than merely to have been
 * running when one appeared.
 *
 * Claims were detected by diffing the repository's worktree list before and after a
 * stage, and everything that appeared in that window was recorded as the stage's doing.
 * That is not an inference about the agent at all — it is an inference about the clock,
 * and the window is minutes long on a repository one person and several concurrent tasks
 * are all working in.
 *
 * It bit on 14 Aug 2026: the operator created `C:/Dev/qube-live-sm` by hand for unrelated
 * work while a promotion stage happened to be running. The tree was filed as that task's,
 * in the `created` class — the class cleanup is allowed to delete — so removing the task
 * would have offered up a checkout the harness had nothing to do with. The same window
 * catches another task's concurrent stage and a branch switched by hand.
 *
 * So attribution comes from evidence the harness already holds: `SubtaskActivity.commands`
 * are recorded **verbatim** for exactly this kind of after-the-fact question. A worktree
 * is claimed only when it appeared *and* one of the stage's own commands names it.
 *
 * The failure direction is deliberate. A worktree the stage really made but never named —
 * created inside a script, say — is claimed by nobody, so it lists as an orphan: visible,
 * reversible, and adoptable. The alternative failure deletes somebody's directory.
 *
 * The commands must be taken from the **reply**, never re-read from the pipeline. Every
 * early exit reverts the subtask, which discards its activity, and those are exactly the
 * paths a promotion stage leaves by — a question, a stop, a held permission. Re-reading
 * would lose the evidence precisely where the claim matters most.
 */

/**
 * Whether any of a stage's commands names this worktree.
 *
 * Matched on the **last path segment**, which is deliberately looser than comparing whole
 * paths. A command writes a path however the shell it ran in spells one — `C:/Dev/x`,
 * `C:\Dev\x`, `/c/Dev/x`, or `../x` from some other directory — and a claim lost to a
 * spelling difference is a real worktree attributed to nobody.
 *
 * Loose is safe here only because this is a *conjunction*: the path must also have
 * appeared during this stage, in this repository. On its own, matching a directory name
 * inside command text would attribute far too much.
 */
export function pathNamedInCommands(
  path: string,
  commands: readonly string[],
): boolean {
  const segment = lastSegment(path);
  if (!segment) return false;
  return commands.some((command) => command.toLowerCase().includes(segment));
}

function lastSegment(path: string): string {
  const parts = path
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase()
    .split("/");
  return parts[parts.length - 1] ?? "";
}
