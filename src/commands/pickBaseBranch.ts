import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { orderBaseBranchChoices } from "../domain/baseBranchChoices";

const TYPE_IT = "$(edit) Type a branch name…";

/**
 * Asks for the base branch by listing the branches that exist.
 *
 * Shared by every flow that needs one, because the answer means the same thing in all
 * of them: what later stages diff against. Single-select, since a task has exactly one
 * base — the picker is a searchable list, not a set.
 *
 * Falls back to a free-text box when the branches cannot be listed, and offers one from
 * the list as well: a base may name a remote-only branch or a tag, and a picker that
 * cannot express those would be narrower than the box it replaced.
 */
export async function pickBaseBranch(
  ctx: CommandContext,
  repositoryRoot: string,
  scope: vscode.Uri | undefined,
  title: string,
): Promise<string | undefined> {
  let defaultBase = ctx.configuration.defaultBaseBranch(scope);
  if (!defaultBase) {
    const current = await ctx.worktrees.getCurrentBranch(repositoryRoot);
    defaultBase = current.ok && current.value ? current.value : "HEAD";
  }

  const listed = await ctx.merges.listBranches(repositoryRoot);
  if (!listed.ok) {
    ctx.logger.warn("Could not list branches for the base-branch picker.");
    return typeBaseBranch(title, defaultBase);
  }

  const choices = orderBaseBranchChoices(listed.value, defaultBase);
  const picked = await vscode.window.showQuickPick([...choices, TYPE_IT], {
    title,
    placeHolder: "Base branch — what this work is compared against",
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked === TYPE_IT) return typeBaseBranch(title, defaultBase);
  return picked;
}

async function typeBaseBranch(
  title: string,
  defaultBase: string,
): Promise<string | undefined> {
  const typed = await vscode.window.showInputBox({
    title,
    prompt: "Base branch",
    value: defaultBase,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "Base branch is required." : undefined,
  });
  return typed?.trim() || undefined;
}
