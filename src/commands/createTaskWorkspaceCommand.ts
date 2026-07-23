import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { ServiceError } from "../services/taskWorkspaceService";

/**
 * Multi-step create flow: name → branch type → base branch → description,
 * then a confirmation showing the generated branch and path before creation.
 */
export async function createTaskWorkspaceCommand(
  ctx: CommandContext,
): Promise<void> {
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) {
    void vscode.window.showErrorMessage(
      "No Git repository is open. Open a repository folder first.",
    );
    return;
  }
  const scope = ctx.repositoryUri();

  const name = await vscode.window.showInputBox({
    title: "Create Task Workspace",
    prompt: "Task name",
    placeHolder: "e.g. Campaign performance report",
    validateInput: (value) =>
      value.trim().length === 0 ? "Task name is required." : undefined,
  });
  if (!name) return;

  const prefixes = ctx.configuration.branchPrefixes(scope);
  const branchPrefix = await vscode.window.showQuickPick(prefixes, {
    title: "Create Task Workspace",
    placeHolder: "Branch type",
  });
  if (!branchPrefix) return;

  // Resolve default base branch (config, else current HEAD branch).
  let defaultBase = ctx.configuration.defaultBaseBranch(scope);
  if (!defaultBase) {
    const current = await ctx.worktrees.getCurrentBranch(repositoryRoot);
    defaultBase = current.ok && current.value ? current.value : "HEAD";
  }
  const baseBranch = await vscode.window.showInputBox({
    title: "Create Task Workspace",
    prompt: "Base branch",
    value: defaultBase,
    validateInput: (value) =>
      value.trim().length === 0 ? "Base branch is required." : undefined,
  });
  if (!baseBranch) return;

  const description = await vscode.window.showInputBox({
    title: "Create Task Workspace",
    prompt: "Description (optional)",
    placeHolder: "What is this task about?",
  });
  // A cancelled (Escape) description returns undefined; treat as no description.

  const configuredParentDir = ctx.configuration.worktreeParentDir(scope);
  const proposal = ctx.service.proposeTask({
    repositoryRoot,
    name,
    branchPrefix,
    configuredParentDir,
  });
  if (!proposal.ok) {
    void vscode.window.showErrorMessage(describeCreateError(proposal.error));
    return;
  }

  const confirm = await vscode.window.showInformationMessage(
    `Create task "${name.trim()}"?`,
    {
      modal: true,
      detail: `Branch: ${proposal.value.branchName}\nBase: ${baseBranch.trim()}\nWorktree: ${proposal.value.worktreePath}`,
    },
    "Create",
  );
  if (confirm !== "Create") return;

  const created = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Creating worktree…", cancellable: true },
    (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      return ctx.service.createTask(
        {
          repositoryRoot,
          name,
          branchPrefix,
          baseBranch: baseBranch.trim(),
          description,
          configuredParentDir,
        },
        controller.signal,
      );
    },
  );

  if (!created.ok) {
    void vscode.window.showErrorMessage(describeCreateError(created.error));
    return;
  }

  ctx.tree.refresh();

  const action = await vscode.window.showInformationMessage(
    `Task "${created.value.name}" created.`,
    "Open Workspace",
    "Start Claude",
    "Copy Path",
  );
  if (action === "Open Workspace") {
    await vscode.commands.executeCommand("taskWorkspaces.open", created.value.id);
  } else if (action === "Start Claude") {
    await vscode.commands.executeCommand("taskWorkspaces.startAgent", created.value.id);
  } else if (action === "Copy Path") {
    await vscode.env.clipboard.writeText(created.value.worktreePath);
  }
}

function describeCreateError(error: ServiceError): string {
  if (error.kind === "validation") {
    return error.message;
  }
  if (error.kind === "notFound") {
    return error.message;
  }
  const inner = error.error;
  if (inner.kind === "validation" || inner.kind === "dirty" || inner.kind === "unmerged") {
    return inner.message;
  }
  return `Git error: ${inner.error.message}`;
}
