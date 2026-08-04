import { TaskWorkspace } from "../domain/taskWorkspace";
import { normalizeRoot } from "./taskRepository";

/**
 * One-time hand-off from the VS Code Memento to the per-repository state file.
 *
 * The shapes do not line up: the Memento is *global* and holds tasks for every
 * repository in a single blob, while the file store is per-repository under
 * that repo's git directory. The extension cannot fan the blob out on its own —
 * the other repositories' clones may not even be mounted, and writing into a
 * git dir we have not resolved would be a guess.
 *
 * So adoption is lazy and per-repository: the first time a repo is opened with
 * no state file, it takes the Memento's entries for that root. The Memento is
 * left untouched, which makes this safe to get wrong — if adoption misfires,
 * the original blob is still there to adopt again.
 */

export interface AdoptionPlan {
  /** Tasks to seed the new state file with. Never empty. */
  seed: TaskWorkspace[];
  /** Note for the log, so a silent hand-off is visible after the fact. */
  note: string;
}

export interface AdoptionInputs {
  /** True when the repo already has a state file — adoption is then finished. */
  stateFileExists: boolean;
  /** Everything the Memento holds, across all repositories. */
  legacyTasks: TaskWorkspace[];
  repositoryRoot: string;
}

/**
 * Returns what to seed, or `undefined` when there is nothing to do. Deciding
 * separately from acting keeps the rule testable and the caller a thin shell.
 */
export function planLegacyAdoption(inputs: AdoptionInputs): AdoptionPlan | undefined {
  // A file already present is the marker that this repo has been adopted.
  // Re-seeding would resurrect tasks the user has since deleted.
  if (inputs.stateFileExists) return undefined;

  const key = normalizeRoot(inputs.repositoryRoot);
  const mine = inputs.legacyTasks.filter(
    (t) => normalizeRoot(t.repositoryRoot) === key,
  );
  if (mine.length === 0) return undefined;

  return {
    seed: mine,
    note:
      `Adopted ${mine.length} task(s) for ${inputs.repositoryRoot} from extension state ` +
      "into the repository's own state file. The extension copy is kept as a backup.",
  };
}
