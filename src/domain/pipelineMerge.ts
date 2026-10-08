import { TaskPipeline } from "./taskPipeline";

/**
 * Three-way merge of a pipeline the runner changed in memory against the copy on disk.
 *
 * An advance holds a pipeline for the whole of a subtask — minutes — and writes it
 * back when the session ends. Anything written meanwhile by somebody else was
 * silently reverted by that write: a checklist tick from Claude, a guidance note,
 * a gate declaration the config refresh brought into line, a retired item. Each of
 * those writes worked exactly as designed and then vanished, which is the
 * last-writer-wins the second client made impossible to ignore.
 *
 * `base` is the pipeline the runner's copy was derived from, `ours` the runner's
 * new pipeline, `theirs` what is on disk now. Every value only one side changed is
 * taken from that side, so disjoint edits — by far the common case, since the
 * runner owns the stage it is running and a person acts on a different one — both
 * survive.
 *
 * Generic over JSON rather than written per field, deliberately. A per-field merge
 * is a second list of the pipeline's fields, and `normalizePipeline` has already
 * shown what a list of fields that somebody forgets to extend costs: the field is
 * dropped. Two shapes need more than "one side changed it":
 *
 * - **Arrays of records with unique string ids** — stages, subtasks, checklist
 *   items, guidance — are matched by id, so a tick on one item and a reply on
 *   another subtask are disjoint edits rather than two versions of one array.
 * - **Arrays both sides only appended to** — the intervention and failure ledgers —
 *   keep both sides' entries. A ledger that lost the other client's entry would be
 *   the erasure `TaskPipeline.discarded` and `failures` were added to end.
 *
 * Where both sides changed one value differently, the runner's value is kept and the
 * path is reported. The runner's write records what a session actually did, which is
 * paid for and cannot be re-derived; a decision from another client is refused while
 * a subtask is in flight (`harnessControl`), so a genuine clash is rare, and it is
 * announced rather than resolved silently.
 */
export interface PipelineMerge {
  pipeline: TaskPipeline;
  /** Where both sides changed one value differently; the runner's value was kept. */
  conflicts: string[];
}

export function mergePipelines(
  base: TaskPipeline,
  ours: TaskPipeline,
  theirs: TaskPipeline,
): PipelineMerge {
  const conflicts: string[] = [];
  const pipeline = merge(base, ours, theirs, "pipeline", conflicts) as TaskPipeline;
  return { pipeline, conflicts };
}

/**
 * Equality as JSON sees it: a property holding `undefined` is the same as one that
 * is absent, because that is what the state file will hold either way. Identity
 * short-circuits first, which is what keeps this cheap — domain transitions return
 * new objects only along the path they changed, so `ours` and `base` share almost
 * every subtree.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = definedKeys(a);
    return keys.length === definedKeys(b).length && keys.every((key) => sameJson(a[key], b[key]));
  }
  return false;
}

function merge(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: string,
  conflicts: string[],
): unknown {
  if (sameJson(ours, theirs) || sameJson(base, theirs)) return ours;
  if (sameJson(base, ours)) return theirs;

  if (isRecord(ours) && isRecord(theirs)) {
    return mergeRecords(isRecord(base) ? base : {}, ours, theirs, path, conflicts);
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const before = Array.isArray(base) ? base : [];
    if (keyedById(before) && keyedById(ours) && keyedById(theirs)) {
      return mergeKeyed(before, ours, theirs, path, conflicts);
    }
    const appended = mergeAppended(before, ours, theirs);
    if (appended) return appended;
  }
  conflicts.push(path);
  return ours;
}

function mergeRecords(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  conflicts: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
  for (const key of keys) {
    const value = merge(base[key], ours[key], theirs[key], `${path}.${key}`, conflicts);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

type Keyed = Record<string, unknown> & { id: string };

function mergeKeyed(
  base: Keyed[],
  ours: Keyed[],
  theirs: Keyed[],
  path: string,
  conflicts: string[],
): Keyed[] {
  const baseById = byId(base);
  const theirsById = byId(theirs);
  const oursById = byId(ours);
  const result: Keyed[] = [];

  for (const item of ours) {
    const at = `${path}[${item.id}]`;
    const before = baseById.get(item.id);
    const there = theirsById.get(item.id);
    if (there) {
      result.push(merge(before, item, there, at, conflicts) as Keyed);
    } else if (!before) {
      result.push(item);
    } else if (!sameJson(before, item)) {
      // Removed there, changed here. Kept: dropping it would lose the change.
      conflicts.push(at);
      result.push(item);
    }
    // Otherwise removed there and untouched here, so it stays removed.
  }

  theirs.forEach((item, index) => {
    if (oursById.has(item.id)) return;
    const before = baseById.get(item.id);
    if (before) {
      // Removed here. If the other side also changed it, that change is lost — say so.
      if (!sameJson(before, item)) conflicts.push(`${path}[${item.id}]`);
      return;
    }
    // Added there: placed after the nearest item that preceded it on that side, so an
    // appended entry lands at the end and an inserted stage lands where it was put.
    let position = 0;
    for (let i = index - 1; i >= 0; i--) {
      const found = result.findIndex((kept) => kept.id === theirs[i].id);
      if (found !== -1) {
        position = found + 1;
        break;
      }
    }
    result.splice(position, 0, item);
  });

  return result;
}

/** Both sides only appended: keep the shared prefix, then each side's new entries. */
function mergeAppended(base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] | undefined {
  const isPrefix = (whole: unknown[]) =>
    whole.length >= base.length && base.every((item, i) => sameJson(item, whole[i]));
  if (!isPrefix(ours) || !isPrefix(theirs)) return undefined;
  const ourNew = ours.slice(base.length);
  const theirNew = theirs
    .slice(base.length)
    .filter((item) => !ourNew.some((mine) => sameJson(mine, item)));
  return [...ours, ...theirNew];
}

function keyedById(items: unknown[]): items is Keyed[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string" || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

function byId(items: Keyed[]): Map<string, Keyed> {
  return new Map(items.map((item) => [item.id, item]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}
