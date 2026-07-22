import { Result, ok, err } from "./result";

/**
 * Converts a free-text task name into a git-safe branch slug.
 * Lowercases, replaces runs of non-alphanumerics with a single hyphen, and
 * trims leading/trailing hyphens.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds a full branch name from a prefix (branch type) and a task name.
 * Returns an error when the inputs cannot produce a valid ref.
 */
export function buildBranchName(
  prefix: string,
  taskName: string,
): Result<string, string> {
  const cleanPrefix = slugify(prefix);
  const slug = slugify(taskName);

  if (slug.length === 0) {
    return err("Task name must contain at least one alphanumeric character.");
  }

  const branch = cleanPrefix.length > 0 ? `${cleanPrefix}/${slug}` : slug;
  return validateBranchName(branch);
}

/**
 * Validates a branch name against the subset of git's ref rules that matter
 * for our generated names. Not a full `git check-ref-format` reimplementation —
 * git remains the final authority when the ref is actually created.
 */
export function validateBranchName(branch: string): Result<string, string> {
  if (branch.length === 0) {
    return err("Branch name is empty.");
  }
  if (branch.startsWith("/") || branch.endsWith("/")) {
    return err("Branch name may not start or end with a slash.");
  }
  if (branch.startsWith(".") || branch.endsWith(".")) {
    return err("Branch name may not start or end with a dot.");
  }
  if (branch.endsWith(".lock")) {
    return err("Branch name may not end with '.lock'.");
  }
  if (branch.includes("..") || branch.includes("//")) {
    return err("Branch name may not contain '..' or '//'.");
  }
  // Control chars, space, and the special characters git forbids in refs.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(branch)) {
    return err("Branch name contains characters that are not allowed.");
  }
  if (branch.includes("@{")) {
    return err("Branch name may not contain '@{'.");
  }
  return ok(branch);
}
