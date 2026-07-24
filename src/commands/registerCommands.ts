import * as vscode from "vscode";
import {
  CommandContext,
  PENDING_NATIVE_CHAT_KEY,
  CLAUDE_EXTENSION_ID,
} from "./commandContext";
import { createTaskWorkspaceCommand } from "./createTaskWorkspaceCommand";
import {
  TaskWorkspaceTreeItem,
  OrphanWorktreeTreeItem,
} from "../ui/taskWorkspaceTreeItem";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { AgentChatPanel, ChatPanelOptions, ChatController, HistoryEntry } from "../ui/agentChatPanel";
import { providerVisual } from "../agents/agentProviderMeta";
import { scanSlashCommands } from "../agents/slashCommands";
import { loadTranscriptItems, listSessions } from "../agents/transcriptReader";
import * as os from "node:os";
import * as path from "node:path";

/** Registers all extension commands and returns their disposables. */
export function registerCommands(ctx: CommandContext): vscode.Disposable[] {
  const register = (id: string, handler: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(id, (...args) => handler(...args));

  return [
    register("taskWorkspaces.create", () => createTaskWorkspaceCommand(ctx)),
    register("taskWorkspaces.refresh", () => ctx.tree.refresh()),
    register("taskWorkspaces.open", (arg) => openCommand(ctx, arg)),
    register("taskWorkspaces.detail", (arg) => openDetailCommand(ctx, arg)),
    register("taskWorkspaces.showDiff", (arg) => showDiffCommand(ctx, arg)),
    register("taskWorkspaces.copyPath", (arg) => copyPathCommand(ctx, arg)),
    register("taskWorkspaces.archive", (arg) => archiveCommand(ctx, arg)),
    register("taskWorkspaces.unarchive", (arg) => unarchiveCommand(ctx, arg)),
    register("taskWorkspaces.toggleArchived", () => {
      const showing = ctx.tree.toggleArchived();
      void vscode.commands.executeCommand("setContext", "taskWorkspaces.showArchived", showing);
    }),
    register("taskWorkspaces.remove", (arg) => removeCommand(ctx, arg)),
    register("taskWorkspaces.startAgent", (arg) => launchAgentCommand(ctx, arg)),
    register("taskWorkspaces.openChat", (arg) => launchAgentCommand(ctx, arg)),
    register("taskWorkspaces.startNative", (arg) => launchInModeCommand(ctx, arg, "native")),
    register("taskWorkspaces.startChat", (arg) => launchInModeCommand(ctx, arg, "chat")),
    register("taskWorkspaces.startTerminal", (arg) => launchInModeCommand(ctx, arg, "terminal")),
    register("taskWorkspaces.stopAgent", (arg) => stopAgentCommand(ctx, arg)),
    register("taskWorkspaces.adopt", (arg) => adoptCommand(ctx, arg)),
    register("taskWorkspaces.sessionHistory", () => sessionHistoryCommand(ctx)),
  ];
}

/** Browses archived session history of removed tasks and opens it read-only. */
async function sessionHistoryCommand(ctx: CommandContext): Promise<void> {
  const all = ctx.archivedHistory.getAll().sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  if (all.length === 0) {
    void vscode.window.showInformationMessage("No archived task history yet.");
    return;
  }

  const taskPick = await vscode.window.showQuickPick(
    all.map((a) => ({
      label: a.name,
      description: `${a.branchName} · ${a.sessions.length} session(s)`,
      detail: `Archived ${new Date(a.archivedAt).toLocaleString()}`,
      rec: a,
    })),
    { title: "Session History", placeHolder: "Select a removed task" },
  );
  if (!taskPick) return;

  const sessPick = await vscode.window.showQuickPick(
    taskPick.rec.sessions
      .slice()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((s) => ({
        label: s.title,
        description: new Date(s.mtimeMs).toLocaleString(),
        session: s,
      })),
    { title: `${taskPick.rec.name} — sessions`, placeHolder: "Select a session to view" },
  );
  if (!sessPick) return;

  const items = ctx.archive.loadItems(sessPick.session.file);
  const readOnlyController: ChatController = {
    currentMode: () => "default",
    setMode: () => undefined,
    resume: () => undefined,
    listHistory: async () =>
      taskPick.rec.sessions.map((s) => ({ id: s.id, title: s.title, mtimeMs: s.mtimeMs, archived: true })),
    openHistory: async (entry) => {
      const file = taskPick.rec.sessions.find((s) => s.id === entry.id)?.file;
      return { items: file ? ctx.archive.loadItems(file) : [], readOnly: true, title: entry.title };
    },
  };

  AgentChatPanel.show(
    `archived:${taskPick.rec.taskId}`,
    taskPick.rec.name,
    undefined,
    ctx.extensionUri,
    {
      provider: providerVisual("claude-chat"),
      completions: { slash: [], files: [] },
      controller: readOnlyController,
      worktreePath: "",
      compactThreshold: 0,
      initialReadOnly: { title: `${taskPick.rec.name} · ${sessPick.session.title}`, items },
    },
  );
}

async function adoptCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  if (!(arg instanceof OrphanWorktreeTreeItem)) return;
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) return;

  const suggestedName = (arg.branch ?? "")
    .replace(/^.*\//, "")
    .replace(/[-_]+/g, " ")
    .trim();

  const name = await vscode.window.showInputBox({
    title: "Adopt Worktree",
    prompt: "Task name",
    value: suggestedName,
    validateInput: (value) =>
      value.trim().length === 0 ? "Task name is required." : undefined,
  });
  if (!name) return;

  const baseBranch = await vscode.window.showInputBox({
    title: "Adopt Worktree",
    prompt: "Base branch (for future diffs)",
    value: ctx.configuration.defaultBaseBranch(ctx.repositoryUri()) || arg.branch || "main",
    validateInput: (value) =>
      value.trim().length === 0 ? "Base branch is required." : undefined,
  });
  if (!baseBranch) return;

  const result = await ctx.service.adoptWorktree(
    repositoryRoot,
    arg.worktreePath,
    arg.branch ?? "",
    { name, baseBranch: baseBranch.trim() },
  );
  if (!result.ok) {
    const message = result.error.kind === "validation" ? result.error.message : "Failed to adopt worktree.";
    void vscode.window.showErrorMessage(message);
    return;
  }
  ctx.tree.refresh();
  void vscode.window.showInformationMessage(`Adopted "${result.value.name}".`);
}

/** Resolves the target task from a tree item, a task id, or undefined. */
async function resolveTask(
  ctx: CommandContext,
  arg: unknown,
): Promise<TaskWorkspace | undefined> {
  if (arg instanceof TaskWorkspaceTreeItem) return arg.task;
  if (typeof arg === "string") return ctx.repository.get(arg);
  return undefined;
}

async function openCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  const uri = vscode.Uri.file(task.worktreePath);
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceNewWindow: true,
  });
}

async function showDiffCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  const diff = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Computing diff…" },
    () => ctx.status.getFullDiff(task.worktreePath, task.baseBranch),
  );
  if (!diff.ok) {
    void vscode.window.showErrorMessage(`Could not compute diff: ${diff.error.message}`);
    return;
  }

  const uri = ctx.diffProvider.uriFor(task.id, task.name);
  ctx.diffProvider.set(uri, diff.value);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "diff");
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function openDetailCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  ctx.detailView.show(task.id);
  // Reveal the docked Details view.
  await vscode.commands.executeCommand("taskWorkspaces.detail.focus");
}

async function copyPathCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  await vscode.env.clipboard.writeText(task.worktreePath);
  void vscode.window.showInformationMessage("Worktree path copied to clipboard.");
}

async function archiveCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  const result = await ctx.service.archiveTask(task.id);
  if (!result.ok) {
    void vscode.window.showErrorMessage("Failed to archive task.");
    return;
  }
  ctx.tree.refresh();
}

async function unarchiveCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  const result = await ctx.service.unarchiveTask(task.id);
  if (!result.ok) {
    void vscode.window.showErrorMessage("Failed to restore task.");
    return;
  }
  ctx.tree.refresh();
}

async function removeCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  const live = await ctx.service.getLiveState(task);
  const keepBranch = "Remove worktree";
  const withBranch = "Remove worktree + branch";

  // Offer branch deletion as an extra choice in the confirmation box.
  const choice = live.isDirty
    ? await vscode.window.showWarningMessage(
        `"${task.name}" has ${live.changedFileCount} uncommitted change(s). Removing the worktree will discard them.`,
        { modal: true, detail: `Branch: ${task.branchName}` },
        keepBranch,
        withBranch,
      )
    : await vscode.window.showWarningMessage(
        `Remove worktree for "${task.name}"?`,
        { modal: true, detail: `Branch: ${task.branchName}` },
        keepBranch,
        withBranch,
      );
  if (choice !== keepBranch && choice !== withBranch) return;
  const force = live.isDirty;
  const deleteBranch = choice === withBranch;

  // Preserve Claude history before the worktree (and its transcripts) vanish.
  const archived = ctx.archive.archiveWorktree(os.homedir(), task.worktreePath, task.id);
  if (archived.length > 0) {
    await ctx.archivedHistory.add({
      taskId: task.id,
      name: task.name,
      branchName: task.branchName,
      archivedAt: new Date().toISOString(),
      sessions: archived,
    });
    ctx.logger.info(`Archived ${archived.length} session(s) for "${task.name}".`);
  }

  // Stop any associated agent session/terminal before removing the folder.
  ctx.sessions.stop(task.id);
  ctx.terminals.disposeTerminal(task.id);

  const result = await ctx.service.removeTask(task.id, { force });
  if (!result.ok) {
    const message =
      result.error.kind === "worktree" && "error" in result.error
        ? describeWorktreeError(result.error.error)
        : "Failed to remove task workspace.";
    // The git worktree removal failed (e.g. a locked file on Windows). Offer to
    // stop tracking the task anyway so it doesn't linger in the list.
    const pick = await vscode.window.showErrorMessage(
      `${message}`,
      { modal: true, detail: "The worktree folder may still exist on disk. You can stop tracking this task here and remove the folder manually." },
      "Untrack task anyway",
    );
    if (pick === "Untrack task anyway") {
      await ctx.repository.delete(task.id);
      ctx.tree.refresh();
    }
    return;
  }

  if (deleteBranch) {
    await deleteTaskBranch(ctx, task);
  }
  ctx.tree.refresh();
}

/**
 * Deletes a removed task's branch, prompting for a forced delete when it holds
 * commits not merged elsewhere. Non-fatal: the worktree is already gone.
 */
async function deleteTaskBranch(ctx: CommandContext, task: TaskWorkspace): Promise<void> {
  let res = await ctx.worktrees.deleteBranch(task.repositoryRoot, task.branchName, { force: false });
  if (!res.ok && res.error.kind === "unmerged") {
    const choice = await vscode.window.showWarningMessage(
      `Branch "${task.branchName}" has commits not merged elsewhere. Delete it anyway?`,
      { modal: true, detail: "These commits will be lost." },
      "Delete Branch",
    );
    if (choice !== "Delete Branch") return;
    res = await ctx.worktrees.deleteBranch(task.repositoryRoot, task.branchName, { force: true });
  }
  if (!res.ok) {
    void vscode.window.showErrorMessage(
      `Worktree removed, but branch "${task.branchName}" could not be deleted: ${describeWorktreeError(res.error)}`,
    );
    return;
  }
  ctx.logger.info(`Deleted branch "${task.branchName}".`);
}

async function launchAgentCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  await launchAgent(ctx, task, ctx.configuration.agentMode(ctx.repositoryUri()));
}

/** Launches a specific surface directly (from a dedicated toolbar button). */
async function launchInModeCommand(
  ctx: CommandContext,
  arg: unknown,
  mode: "native" | "chat" | "terminal",
): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  await launchAgent(ctx, task, mode);
}

async function launchAgent(
  ctx: CommandContext,
  task: TaskWorkspace,
  mode: "native" | "chat" | "terminal",
): Promise<void> {
  if (mode === "native") {
    await launchNativeChat(ctx, task);
    return;
  }

  const available = await ctx.sessions.isAvailable();
  if (!available) {
    void vscode.window.showErrorMessage(
      `Claude CLI was not found. Check the "taskWorkspaces.claudeCommand" setting or install the CLI.`,
    );
    return;
  }

  if (mode === "chat") {
    await startChatSession(ctx, task);
    return;
  }

  // Terminal mode.
  const provider = ctx.agents.get("claude-code");
  if (!provider) {
    void vscode.window.showErrorMessage("No terminal agent provider is registered.");
    return;
  }
  const session = await provider.startSession(task, {});
  await ctx.repository.save({ ...task, agent: session, updatedAt: new Date().toISOString() });
  ctx.tree.refresh();
}

/**
 * Opens the task's worktree in a new window and asks that window to launch the
 * official Claude Code extension's chat. Cross-window automation is done via a
 * shared globalState flag that the new window's activation picks up.
 */
async function launchNativeChat(
  ctx: CommandContext,
  task: TaskWorkspace,
): Promise<void> {
  if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    const choice = await vscode.window.showWarningMessage(
      "The official Claude Code extension is not installed. Use the built-in chat panel instead?",
      "Use Built-in Chat",
    );
    if (choice === "Use Built-in Chat") await startChatSession(ctx, task);
    return;
  }

  await ctx.globalState.update(PENDING_NATIVE_CHAT_KEY, task.worktreePath);
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(task.worktreePath),
    { forceNewWindow: true },
  );
}

async function startChatSession(
  ctx: CommandContext,
  task: TaskWorkspace,
): Promise<void> {
  const options = await buildChatOptions(ctx, task);

  // Reveal a still-alive session's panel rather than starting a new one.
  const existing = ctx.sessions.get(task.id);
  if (existing && existing.status !== "stopped" && existing.status !== "failed") {
    AgentChatPanel.show(task.id, task.name, existing, ctx.extensionUri, options);
    return;
  }
  if (existing) ctx.sessions.stop(task.id); // clear a dead session before restarting

  // Continue a prior Claude session for this task if we have one.
  const resumeSessionId =
    task.agent?.provider === "claude-chat" ? task.agent.sessionId : undefined;

  // No initial prompt is required — the panel opens ready and the user types
  // the first message there.
  const permissionMode = ctx.configuration.permissionMode(ctx.repositoryUri());
  const session = ctx.sessions.getOrStart(task.id, {
    worktreePath: task.worktreePath,
    permissionMode,
    addDirs: [task.repositoryRoot],
    resumeSessionId,
  });

  // Replay the prior transcript into the panel so history is visible.
  if (resumeSessionId && session.items.length === 0) {
    const prior = loadTranscriptItems(os.homedir(), resumeSessionId);
    if (prior.length > 0) session.items.unshift(...prior);
  }

  const agentSession = {
    provider: "claude-chat",
    sessionId: session.id,
    status: "running" as const,
    startedAt: new Date().toISOString(),
  };
  await ctx.repository.save({ ...task, agent: agentSession, updatedAt: new Date().toISOString() });
  ctx.tree.refresh();

  AgentChatPanel.show(task.id, task.name, session, ctx.extensionUri, options);
}

/** Gathers provider visuals, completions and the live controller for the panel. */
async function buildChatOptions(
  ctx: CommandContext,
  task: TaskWorkspace,
): Promise<ChatPanelOptions> {
  const slash = scanSlashCommands(
    path.join(task.worktreePath, ".claude", "commands"),
    path.join(os.homedir(), ".claude", "commands"),
  ).map((c) => c.name);

  const filesResult = await ctx.worktrees.listFiles(task.worktreePath);
  const files = filesResult.ok ? filesResult.value : [];

  return {
    provider: providerVisual("claude-chat"),
    completions: { slash, files },
    controller: buildController(ctx, task),
    worktreePath: task.worktreePath,
    compactThreshold: ctx.configuration.compactPromptThreshold(ctx.repositoryUri()),
  };
}

/** Live controller: mode switching, history listing, and resume. */
function buildController(ctx: CommandContext, task: TaskWorkspace): ChatController {
  let mode = ctx.configuration.permissionMode(ctx.repositoryUri());

  const startResumed = (resumeSessionId: string | undefined) => {
    const prior = ctx.sessions.get(task.id);
    const carried = prior ? [...prior.items] : [];
    const session = ctx.sessions.create(task.id, {
      worktreePath: task.worktreePath,
      permissionMode: mode,
      addDirs: [task.repositoryRoot],
      resumeSessionId,
    });
    if (session.items.length === 0) {
      const fromDisk = resumeSessionId ? loadTranscriptItems(os.homedir(), resumeSessionId) : [];
      const items = fromDisk.length > 0 ? fromDisk : carried;
      if (items.length > 0) session.items.unshift(...items);
    }
    void ctx.repository.save({
      ...task,
      agent: { provider: "claude-chat", sessionId: session.id, status: "running", startedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
    return session;
  };

  return {
    currentMode: () => mode,
    setMode: (m) => {
      mode = m as typeof mode;
      // Persist so subsequent chats in this project default to the chosen mode.
      void ctx.configuration.setPermissionMode(mode, ctx.repositoryUri());
      const current = ctx.sessions.get(task.id);
      return startResumed(current?.id ?? (task.agent?.provider === "claude-chat" ? task.agent.sessionId : undefined));
    },
    resume: () => {
      const current = ctx.sessions.get(task.id);
      return startResumed(current?.id ?? (task.agent?.provider === "claude-chat" ? task.agent.sessionId : undefined));
    },
    listHistory: async () => {
      const live: HistoryEntry[] = listSessions(os.homedir(), task.worktreePath).map((s) => ({
        id: s.id, title: s.title, mtimeMs: s.mtimeMs, archived: false,
      }));
      const liveIds = new Set(live.map((e) => e.id));
      const rec = ctx.archivedHistory.get(task.id);
      const archived: HistoryEntry[] = (rec?.sessions ?? [])
        .filter((s) => !liveIds.has(s.id))
        .map((s) => ({ id: s.id, title: s.title, mtimeMs: s.mtimeMs, archived: true }));
      return [...live, ...archived].sort((a, b) => b.mtimeMs - a.mtimeMs);
    },
    openHistory: async (entry) => {
      if (!entry.archived) {
        return { session: startResumed(entry.id), readOnly: false, title: entry.title };
      }
      const rec = ctx.archivedHistory.get(task.id);
      const file = rec?.sessions.find((s) => s.id === entry.id)?.file;
      return { items: file ? ctx.archive.loadItems(file) : [], readOnly: true, title: entry.title };
    },
  };
}

async function stopAgentCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  ctx.sessions.stop(task.id);
  ctx.terminals.disposeTerminal(task.id);
  if (task.agent) {
    await ctx.repository.save({
      ...task,
      agent: { ...task.agent, status: "stopped", stoppedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
  }
  ctx.tree.refresh();
}

function describeWorktreeError(error: unknown): string {
  const e = error as { kind?: string; message?: string; error?: { message?: string } };
  if (e?.kind === "dirty" && e.message) return e.message;
  if (e?.kind === "unmerged" && e.message) return e.message;
  if (e?.kind === "validation" && e.message) return e.message;
  if (e?.error?.message) return `Git error: ${e.error.message}`;
  return "Failed to remove task workspace.";
}
