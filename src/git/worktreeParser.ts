import { GitWorktree } from "./types";

/**
 * Parses the output of `git worktree list --porcelain`.
 *
 * Records are separated by blank lines. Each record begins with a `worktree`
 * line and may contain: `HEAD <hash>`, `branch refs/heads/<name>`, `bare`,
 * `detached`, `locked [reason]`, `prunable [reason]`.
 *
 * Pure function — no I/O — so it is exhaustively unit-tested against fixtures.
 */
export function parseWorktreeList(porcelain: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  const flush = () => {
    if (current) {
      worktrees.push(current);
      current = null;
    }
  };

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.trim() === "") {
      flush();
      continue;
    }

    const spaceIndex = line.indexOf(" ");
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);

    switch (key) {
      case "worktree":
        flush();
        current = {
          path: value,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        };
        break;
      case "HEAD":
        if (current) current.head = value;
        break;
      case "branch":
        if (current) current.branch = stripRefsHeads(value);
        break;
      case "bare":
        if (current) current.bare = true;
        break;
      case "detached":
        if (current) current.detached = true;
        break;
      case "locked":
        if (current) current.locked = true;
        break;
      case "prunable":
        if (current) current.prunable = true;
        break;
      default:
        // Unknown attributes are ignored for forward compatibility.
        break;
    }
  }

  flush();
  return worktrees;
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}
