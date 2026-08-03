import * as vscode from "vscode";
import { CopyEntry } from "../domain/worktreeCopyPlan";

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

  /**
   * Files and directories copied into every new worktree. A fresh worktree lacks
   * everything git does not track, so untracked local config has to be brought
   * across or an agent behaves differently there than in the main checkout.
   */
  copyIntoWorktree(scope?: vscode.Uri): CopyEntry[] {
    return this.config(scope).get<CopyEntry[]>("copyIntoWorktree", []);
  }

  /**
   * Location of the project's review-rules file. Empty means the conventional
   * path inside the repository. Resource-scoped, so each project can differ.
   */
  reviewRulesPath(scope?: vscode.Uri): string {
    return this.config(scope).get<string>("reviewRulesPath", "").trim();
  }

  /**
   * Location of the project's harness config (routes + review rules). Falls back
   * to the older `reviewRulesPath` when only that is set, so an existing
   * configuration keeps working.
   */
  harnessConfigPath(scope?: vscode.Uri): string {
    const configured = this.config(scope).get<string>("harnessConfigPath", "").trim();
    return configured || this.reviewRulesPath(scope);
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

  /** Model alias/id for chat sessions ("" = CLI default). */
  model(scope?: vscode.Uri): string {
    return this.config(scope).get<string>("model", "").trim();
  }

  /** Persists the chosen model so subsequent chats default to it. */
  async setModel(model: string, scope?: vscode.Uri): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await this.config(scope).update("model", model, target);
  }

  trackNativeActivity(scope?: vscode.Uri): boolean {
    return this.config(scope).get<boolean>("trackNativeActivity", true);
  }

  compactPromptThreshold(scope?: vscode.Uri): number {
    return this.config(scope).get<number>("compactPromptThreshold", 120000);
  }

  /**
   * What to do when a session crosses `autoCompactThreshold`: summarise in place
   * ("compact") or write a handoff and continue in a fresh session
   * ("checkpoint"). Checkpointing keeps carried-forward context bounded.
   */
  contextStrategy(scope?: vscode.Uri): "compact" | "checkpoint" {
    return this.config(scope).get<"compact" | "checkpoint">(
      "contextStrategy",
      "compact",
    );
  }

  autoCompactThreshold(scope?: vscode.Uri): number {
    return this.config(scope).get<number>("autoCompactThreshold", 0);
  }

  /**
   * MCP config to load explicitly into every session, relative to the
   * repository root (or absolute). Empty disables it.
   *
   * Read from the **repository root**, never the worktree, for the same reason
   * review rules are: MCP servers grant tool access, and a branch must not be
   * able to hand itself new capabilities by editing a file.
   */
  mcpConfigPath(scope?: vscode.Uri): string {
    return this.config(scope).get<string>("mcpConfigPath", ".mcp.json").trim();
  }

  /**
   * Hard stop for one subtask, so a hung CLI cannot stall a route forever.
   *
   * Generous by default: a planning stage on a large repository legitimately
   * takes tens of minutes, and per-process overhead on the host machine (virus
   * scanning on spawn, most often) can multiply that several times over. A cap
   * that fires during normal work is worse than no cap, because the stage is
   * recorded as failed.
   */
  stageTimeoutMinutes(scope?: vscode.Uri): number {
    const minutes = this.config(scope).get<number>("stageTimeoutMinutes", 45);
    return minutes > 0 ? minutes : 45;
  }
}
