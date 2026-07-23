import * as vscode from "vscode";

const SECTION = "taskWorkspaces";

/** Typed accessor over the extension's contributed settings. */
export class ExtensionConfiguration {
  private config(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION, scope ?? null);
  }

  worktreeParentDir(scope?: vscode.Uri): string {
    return this.config(scope).get<string>("worktreeParentDir", "").trim();
  }

  branchPrefixes(scope?: vscode.Uri): string[] {
    const prefixes = this.config(scope).get<string[]>("branchPrefixes", []);
    return prefixes.length > 0
      ? prefixes
      : ["feature", "bug", "fix", "perf", "refactor", "chore"];
  }

  defaultBaseBranch(scope?: vscode.Uri): string {
    return this.config(scope).get<string>("defaultBaseBranch", "").trim();
  }

  claudeCommand(scope?: vscode.Uri): string {
    return this.config(scope).get<string>("claudeCommand", "claude").trim() || "claude";
  }

  agentMode(scope?: vscode.Uri): "native" | "chat" | "terminal" {
    return this.config(scope).get<"native" | "chat" | "terminal">("agentMode", "native");
  }

  permissionMode(scope?: vscode.Uri): "default" | "acceptEdits" | "plan" | "bypassPermissions" {
    return this.config(scope).get("permissionMode", "acceptEdits");
  }

  /**
   * Persists the permission mode so subsequent chats default to it. Writes to
   * workspace settings when a workspace is open, else to global settings.
   */
  async setPermissionMode(
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
    scope?: vscode.Uri,
  ): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await this.config(scope).update("permissionMode", mode, target);
  }

  trackNativeActivity(scope?: vscode.Uri): boolean {
    return this.config(scope).get<boolean>("trackNativeActivity", true);
  }

  compactPromptThreshold(scope?: vscode.Uri): number {
    return this.config(scope).get<number>("compactPromptThreshold", 120000);
  }
}
