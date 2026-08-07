import * as path from "node:path";

/**
 * Links to sibling repositories, created *beside* the worktrees rather than inside
 * them.
 *
 * The problem this solves: a project can reference a sibling repository by a
 * relative path — `..\..\QubeData\QubeData.csproj` — which resolves correctly from
 * a checkout sitting next to that sibling, and incorrectly from a worktree parked
 * one level deeper in its own folder. A `Directory.Build.props` can probe for the
 * sibling and fix *project* references, but a `.sln` cannot: solution files take no
 * MSBuild properties, so the path in them is the path that must exist.
 *
 * Hence a link in the worktree parent directory. It restores the layout the
 * checked-in paths already assume, rather than asking every consumer of those
 * paths to learn about worktrees.
 *
 * Provisioned rather than remembered. A junction made by hand works exactly as well
 * until someone builds on another machine, where the failure is a missing project
 * with nothing to suggest that a link is what is absent.
 */

/** A configured link: a target path, or an explicit name/target pair. */
export type SiblingLinkEntry = string | { name?: string; target: string };

export interface SiblingLinkOperation {
  /** Absolute path the link is created at, inside the worktree parent directory. */
  linkPath: string;
  /** Absolute path the link points to. */
  targetPath: string;
  /** The entry as configured, for messages. */
  label: string;
}

export interface SiblingLinkPlan {
  operations: SiblingLinkOperation[];
  /** Entries that were rejected, with the reason. */
  problems: string[];
}

export function resolveSiblingLinkPlan(
  entries: readonly SiblingLinkEntry[],
  repositoryRoot: string,
  worktreePath: string,
): SiblingLinkPlan {
  const operations: SiblingLinkOperation[] = [];
  const problems: string[] = [];
  const parentDir = path.dirname(path.normalize(worktreePath));
  const seen = new Set<string>();

  for (const entry of entries) {
    const target = typeof entry === "string" ? entry : entry.target;
    if (typeof target !== "string" || target.trim().length === 0) {
      problems.push(`Ignoring a link entry with no target.`);
      continue;
    }

    const absoluteTarget = path.isAbsolute(target)
      ? path.normalize(target)
      : path.resolve(repositoryRoot, target);

    // Defaulted from the target's own folder name, which is what the referencing
    // path almost always spells. Windows compares case-insensitively, so a repo
    // cloned as "qubedata" still satisfies a reference to "QubeData" — but the
    // name is configurable because that is not true everywhere, and a link whose
    // case is wrong on a case-sensitive host fails in a way that reads as missing.
    const configuredName = typeof entry === "string" ? undefined : entry.name;
    const name = (configuredName ?? path.basename(absoluteTarget)).trim();
    if (name.length === 0) {
      problems.push(`Ignoring "${target}": the link name is empty.`);
      continue;
    }

    // A single path segment, always. Anything else — a separator, a "..", a drive
    // — would place the link outside the worktree parent, and this runs with
    // whatever rights the editor has.
    if (name !== path.basename(name) || name === "." || name === "..") {
      problems.push(
        `Ignoring "${name}": a link name must be a single folder name, not a path.`,
      );
      continue;
    }

    const linkPath = path.join(parentDir, name);
    const key = linkPath.toLowerCase();
    if (seen.has(key)) {
      problems.push(`Ignoring a second entry for "${name}": it is already linked.`);
      continue;
    }
    seen.add(key);

    // A link pointing at its own location, or at a directory containing it, makes
    // a loop that tools walking the tree do not survive.
    if (key === path.normalize(absoluteTarget).toLowerCase()) {
      problems.push(`Ignoring "${name}": the link and its target are the same path.`);
      continue;
    }

    operations.push({
      linkPath,
      targetPath: absoluteTarget,
      label: configuredName ? `${name} → ${absoluteTarget}` : absoluteTarget,
    });
  }

  return { operations, problems };
}
