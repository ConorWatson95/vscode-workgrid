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
 *
 * **Shown before the git calls finish**, which is the difference between this and the
 * first version. Awaiting them first put ~110ms of git in the middle of an interactive
 * flow — and when the extension host was busy, that became a pause long enough to read as
 * the command having failed. A `createQuickPick` appears immediately with `busy` set and
 * fills in when the answers arrive, so the flow never has a dead moment; the two calls run
 * concurrently rather than one after the other, since neither needs the other's answer.
 */
export async function pickBaseBranch(
  ctx: CommandContext,
  repositoryRoot: string,
  scope: vscode.Uri | undefined,
  title: string,
): Promise<string | undefined> {
  const configured = ctx.configuration.defaultBaseBranch(scope);

  const pick = vscode.window.createQuickPick();
  pick.title = title;
  pick.placeholder = "Base branch — what this work is compared against";
  pick.ignoreFocusOut = true;
  pick.busy = true;
  pick.show();

  const [current, listed] = await Promise.all([
    configured ? undefined : ctx.worktrees.getCurrentBranch(repositoryRoot),
    ctx.merges.listBranches(repositoryRoot),
  ]);

  const defaultBase =
    configured || (current?.ok && current.value ? current.value : "HEAD");

  if (!listed.ok) {
    ctx.logger.warn("Could not list branches for the base-branch picker.");
    pick.dispose();
    return typeBaseBranch(title, defaultBase);
  }

  const choices = orderBaseBranchChoices(listed.value, defaultBase);
  pick.items = [...choices, TYPE_IT].map((label) => ({ label }));
  // The default is pre-selected rather than merely first, so Enter alone still accepts
  // it — the one keystroke the free-text box used to cost.
  pick.activeItems = pick.items.slice(0, 1);
  pick.busy = false;

  const picked = await new Promise<string | undefined>((resolve) => {
    pick.onDidAccept(() => resolve(pick.selectedItems[0]?.label));
    pick.onDidHide(() => resolve(undefined));
  });
  pick.dispose();

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
