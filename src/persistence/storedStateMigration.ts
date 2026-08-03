import { TaskWorkspace } from "../domain/taskWorkspace";
import { normalizePipeline } from "../domain/taskPipeline";

/**
 * Migration for the persisted task blob.
 *
 * Extracted from the Memento-backed repository so it can be tested without the
 * extension host. The rule this enforces: **never discard user data.** Tasks
 * carry the only copy of a worktree's friendly metadata — name, description,
 * base branch, agent history — and worktrees with no matching task are
 * reported as orphans, so dropping the blob silently turns a user's whole task
 * list into a list of unadopted strangers. Anything unreadable is quarantined
 * for inspection instead.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export interface StoredState {
  schemaVersion: number;
  tasks: TaskWorkspace[];
}

export interface MigrationOutcome {
  /** Tasks safe to use. */
  tasks: TaskWorkspace[];
  /**
   * Entries that could not be understood, kept verbatim so the caller can park
   * them under a backup key rather than lose them.
   */
  quarantined: unknown[];
  /** Schema version found on disk, if any. */
  sourceVersion?: number;
  /**
   * True when the blob was written by a newer extension version. Its tasks are
   * still read (our additions are additive), but the caller should avoid
   * rewriting the blob if it can, to preserve fields it does not understand.
   */
  fromNewerVersion: boolean;
  /** Human-readable notes for the log. */
  notes: string[];
}

/**
 * Reads whatever is in storage into usable tasks. Handles: absent state, the
 * current version, older versions, versions from the future, a bare array (a
 * pre-versioning shape), and individual corrupt entries.
 */
export function migrateStoredState(raw: unknown): MigrationOutcome {
  const notes: string[] = [];
  const quarantined: unknown[] = [];

  if (raw === undefined || raw === null) {
    return { tasks: [], quarantined, fromNewerVersion: false, notes };
  }

  // A bare array predates the versioned envelope.
  let entries: unknown[];
  let sourceVersion: number | undefined;

  if (Array.isArray(raw)) {
    entries = raw;
    notes.push("Found an unversioned task array; treating it as version 0.");
    sourceVersion = 0;
  } else if (typeof raw === "object") {
    const envelope = raw as { schemaVersion?: unknown; tasks?: unknown };
    sourceVersion =
      typeof envelope.schemaVersion === "number"
        ? envelope.schemaVersion
        : undefined;
    if (!Array.isArray(envelope.tasks)) {
      notes.push("Stored state had no readable task array; quarantining it.");
      return {
        tasks: [],
        quarantined: [raw],
        sourceVersion,
        fromNewerVersion: false,
        notes,
      };
    }
    entries = envelope.tasks;
  } else {
    notes.push(`Stored state was a ${typeof raw}, not an object; quarantining it.`);
    return {
      tasks: [],
      quarantined: [raw],
      fromNewerVersion: false,
      notes,
    };
  }

  const fromNewerVersion =
    sourceVersion !== undefined && sourceVersion > CURRENT_SCHEMA_VERSION;
  if (fromNewerVersion) {
    notes.push(
      `Stored state is version ${sourceVersion}, newer than ${CURRENT_SCHEMA_VERSION}. ` +
        "Reading it anyway; unknown fields are preserved.",
    );
  }

  const tasks: TaskWorkspace[] = [];
  for (const entry of entries) {
    const task = migrateTask(entry);
    if (task) {
      tasks.push(task);
    } else {
      quarantined.push(entry);
    }
  }

  if (quarantined.length > 0) {
    notes.push(`${quarantined.length} task entr(y/ies) were unreadable and quarantined.`);
  }

  return { tasks, quarantined, sourceVersion, fromNewerVersion, notes };
}

/**
 * Validates and upgrades a single task. Only the fields the extension cannot
 * function without are required; everything else is optional by design, so a
 * task written by any version remains usable. Unknown fields are preserved so a
 * downgrade followed by an upgrade does not lose data.
 */
function migrateTask(entry: unknown): TaskWorkspace | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const raw = entry as Record<string, unknown>;

  // Identity and location are load-bearing: reconciliation matches on
  // worktreePath, and everything else keys on id.
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  if (typeof raw.worktreePath !== "string" || raw.worktreePath.length === 0) {
    return undefined;
  }
  if (typeof raw.repositoryRoot !== "string" || raw.repositoryRoot.length === 0) {
    return undefined;
  }

  const task = { ...raw } as unknown as TaskWorkspace;

  // Fill fields added after the first release, so older records satisfy the
  // current type without the UI having to guard every access.
  task.name = typeof raw.name === "string" && raw.name ? raw.name : raw.id;
  task.branchName = typeof raw.branchName === "string" ? raw.branchName : "";
  task.baseBranch = typeof raw.baseBranch === "string" ? raw.baseBranch : "";
  task.status = isKnownStatus(raw.status) ? raw.status : "ready";
  task.createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
  task.updatedAt =
    typeof raw.updatedAt === "string" ? raw.updatedAt : task.createdAt;

  // Pipelines predating routes carry only { name, status } stages.
  const pipeline = normalizePipeline(raw.pipeline);
  if (pipeline) {
    task.pipeline = pipeline;
  } else {
    delete task.pipeline;
  }

  return task;
}

const KNOWN_STATUSES: readonly string[] = [
  "creating",
  "ready",
  "planning",
  "implementing",
  "awaiting-approval",
  "reviewing",
  "testing",
  "completed",
  "failed",
  "archived",
];

function isKnownStatus(value: unknown): value is TaskWorkspace["status"] {
  return typeof value === "string" && KNOWN_STATUSES.includes(value);
}
