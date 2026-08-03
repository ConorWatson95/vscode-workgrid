/**
 * Merging allow rules into a Claude settings file.
 *
 * Pure: takes the parsed settings and the rules to add, returns new settings.
 * The file itself is written by `permissionRulesService`, which is the only part
 * that touches disk.
 *
 * Written defensively because this edits a file the user owns and Claude Code
 * reads. Unknown keys are preserved, existing rules are never removed, and a
 * malformed `permissions` block is reported rather than overwritten — silently
 * replacing a settings file the user hand-wrote would be much worse than
 * refusing to.
 */

export interface MergeResult {
  /** The settings to write, or undefined when nothing needed changing. */
  settings?: Record<string, unknown>;
  /** Rules actually added, in order. */
  added: string[];
  /** Rules already present, so not added again. */
  alreadyPresent: string[];
  /** Why the merge was refused, when it was. */
  problem?: string;
}

export function mergeAllowRules(
  existing: unknown,
  rules: readonly string[],
): MergeResult {
  const wanted = rules.map((r) => r.trim()).filter((r) => r.length > 0);
  if (wanted.length === 0) {
    return { added: [], alreadyPresent: [] };
  }

  if (existing !== undefined && existing !== null && !isPlainObject(existing)) {
    return {
      added: [],
      alreadyPresent: [],
      problem: "The settings file does not contain a JSON object.",
    };
  }

  const settings: Record<string, unknown> = isPlainObject(existing)
    ? { ...existing }
    : {};

  const permissions = settings.permissions;
  if (permissions !== undefined && !isPlainObject(permissions)) {
    return {
      added: [],
      alreadyPresent: [],
      problem: '"permissions" exists but is not an object.',
    };
  }

  const block: Record<string, unknown> = isPlainObject(permissions)
    ? { ...permissions }
    : {};

  const allow = block.allow;
  if (allow !== undefined && !isStringArray(allow)) {
    return {
      added: [],
      alreadyPresent: [],
      problem: '"permissions.allow" exists but is not an array of strings.',
    };
  }

  const current: string[] = isStringArray(allow) ? [...allow] : [];
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const rule of wanted) {
    // Exact match only. A prefix rule and a narrower one are different grants,
    // and guessing that one covers the other risks claiming a permission exists
    // when it does not.
    if (current.includes(rule) || added.includes(rule)) {
      if (!alreadyPresent.includes(rule)) alreadyPresent.push(rule);
      continue;
    }
    current.push(rule);
    added.push(rule);
  }

  if (added.length === 0) {
    return { added, alreadyPresent };
  }

  block.allow = current;
  settings.permissions = block;
  return { settings, added, alreadyPresent };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
