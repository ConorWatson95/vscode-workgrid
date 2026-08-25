import * as vscode from "vscode";
import { CopyEntry } from "../domain/worktreeCopyPlan";
import { SiblingLinkEntry } from "../domain/siblingLinkPlan";
import {
  AgentMode,
  ContextStrategy,
  HarnessSettings,
  PermissionMode,
} from "./harnessSettings";

const SECTION = "taskWorkspaces";

/**
 * Typed accessor over the extension's contributed settings.
 *
 * A shell: every default and every normalisation rule lives in
 * `HarnessSettings`, which knows nothing about VS Code. All this adds is the
 * value source and resource scoping — plus the two writers, which stay here
 * because persisting a setting is inherently the editor's job. A headless
 * caller uses `HarnessSettings` directly and gets the readers only.
 */
export class ExtensionConfiguration {
  private settings(scope?: vscode.Uri): HarnessSettings {
    // WorkspaceConfiguration already satisfies SettingsReader.
    return new HarnessSettings(vscode.workspace.getConfiguration(SECTION, scope ?? null));
  }

  worktreeParentDir(scope?: vscode.Uri): string {
    return this.settings(scope).worktreeParentDir();
  }

  branchPrefixes(scope?: vscode.Uri): string[] {
    return this.settings(scope).branchPrefixes();
  }

  defaultBaseBranch(scope?: vscode.Uri): string {
    return this.settings(scope).defaultBaseBranch();
  }

  copyIntoWorktree(scope?: vscode.Uri): CopyEntry[] {
    return this.settings(scope).copyIntoWorktree();
  }

  reviewRulesPath(scope?: vscode.Uri): string {
    return this.settings(scope).reviewRulesPath();
  }

  harnessConfigPath(scope?: vscode.Uri): string {
    return this.settings(scope).harnessConfigPath();
  }

  claudeCommand(scope?: vscode.Uri): string {
    return this.settings(scope).claudeCommand();
  }

  agentMode(scope?: vscode.Uri): AgentMode {
    return this.settings(scope).agentMode();
  }

  permissionMode(scope?: vscode.Uri): PermissionMode {
    return this.settings(scope).permissionMode();
  }

  model(scope?: vscode.Uri): string {
    return this.settings(scope).model();
  }

  trackNativeActivity(scope?: vscode.Uri): boolean {
    return this.settings(scope).trackNativeActivity();
  }

  compactPromptThreshold(scope?: vscode.Uri): number {
    return this.settings(scope).compactPromptThreshold();
  }

  contextStrategy(scope?: vscode.Uri): ContextStrategy {
    return this.settings(scope).contextStrategy();
  }

  autoCompactThreshold(scope?: vscode.Uri): number {
    return this.settings(scope).autoCompactThreshold();
  }

  pauseOnPermissionDenial(scope?: vscode.Uri): boolean {
    return this.settings(scope).pauseOnPermissionDenial();
  }

  gateInterpreter(scope?: vscode.Uri): string {
    return this.settings(scope).gateInterpreter();
  }

  advanceAfterAnswering(scope?: vscode.Uri): boolean {
    return this.settings(scope).advanceAfterAnswering();
  }

  interactiveQuestions(scope?: vscode.Uri): boolean {
    return this.settings(scope).interactiveQuestions();
  }

  interactivePermissions(scope?: vscode.Uri): boolean {
    return this.settings(scope).interactivePermissions();
  }

  gatedTools(scope?: vscode.Uri): string[] {
    return this.settings(scope).gatedTools();
  }

  additionalStageTools(scope?: vscode.Uri): string[] {
    return this.settings(scope).additionalStageTools();
  }

  permissionWaitMinutes(scope?: vscode.Uri): number {
    return this.settings(scope).permissionWaitMinutes();
  }

  holdEveryToolCall(scope?: vscode.Uri): boolean {
    return this.settings(scope).holdEveryToolCall();
  }

  projectDocsPath(scope?: vscode.Uri): string {
    return this.settings(scope).projectDocsPath();
  }

  mcpConfigPath(scope?: vscode.Uri): string {
    return this.settings(scope).mcpConfigPath();
  }

  stageMcpServers(scope?: vscode.Uri): string[] {
    return this.settings(scope).stageMcpServers();
  }

  linkSiblings(scope?: vscode.Uri): SiblingLinkEntry[] {
    return this.settings(scope).linkSiblings();
  }

  stageTimeoutMinutes(scope?: vscode.Uri): number {
    return this.settings(scope).stageTimeoutMinutes();
  }

  askTimeoutMinutes(scope?: vscode.Uri): number {
    return this.settings(scope).askTimeoutMinutes();
  }

  amendmentModel(scope?: vscode.Uri): string {
    return this.settings(scope).amendmentModel();
  }

  transientRetryAttempts(scope?: vscode.Uri): number {
    return this.settings(scope).transientRetryAttempts();
  }

  stageSubagentConcurrency(scope?: vscode.Uri): number {
    return this.settings(scope).stageSubagentConcurrency();
  }

  stageSubagentDepth(scope?: vscode.Uri): number {
    return this.settings(scope).stageSubagentDepth();
  }

  /**
   * Persists the permission mode so subsequent chats default to it. Writes to
   * workspace settings when a workspace is open, else to global settings.
   */
  async setPermissionMode(mode: PermissionMode, scope?: vscode.Uri): Promise<void> {
    await this.write("permissionMode", mode, scope);
  }

  /** Persists the chosen model so subsequent chats default to it. */
  async setModel(model: string, scope?: vscode.Uri): Promise<void> {
    await this.write("model", model, scope);
  }

  private async write(key: string, value: unknown, scope?: vscode.Uri): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration(SECTION, scope ?? null)
      .update(key, value, target);
  }
}
