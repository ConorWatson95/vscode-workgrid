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
import {
  loadTranscriptItems,
  loadTranscriptItemsSync,
  listSessions,
  transcriptExists,
} from "../agents/transcriptReader";
import { LiveAgentSession } from "../agents/claudeAgents";
import { ChatItem } from "../agents/streamJson";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

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
    register("taskWorkspaces.removeOrphan", (arg) => removeOrphanCommand(ctx, arg)),
    register("taskWorkspaces.openInVisualStudio", (arg) => openInVisualStudioCommand(ctx, arg)),
    register("taskWorkspaces.revealInExplorer", (arg) => revealInExplorerCommand(ctx, arg)),
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
    currentModel: () => "",
    setModel: () => undefined,
    resume: () => undefined,
    newSession: () => undefined,
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

/**
 * Records what a replay actually recovered from disk.
 *
 * Missing history is otherwise impossible to attribute: the transcript trails
 * the live conversation (the CLI writes a reply when the turn completes), so
 * "it was on screen but gone after reload" and "it never reached the file" look
 * identical from the UI. Logging the tail distinguishes them.
 */
function logReplay(ctx: CommandContext, sessionId: string, items: ChatItem[]): void {
  const last = items[items.length - 1];
  const tail = last && "text" in last ? last.text.replace(/\s+/g, " ").slice(0, 120) : "(none)";
  ctx.logger.info(
    `Replayed ${items.length} item(s) from session ${sessionId}; last item [${last?.kind ?? "-"}]: ${tail}`,
  );
}

/**
 * Removes an untracked worktree, optionally deleting its branch.
 *
 * Adopting one just to delete it was the only route before, which meant
 * creating a task to destroy it. Deliberately mirrors the tracked Remove
 * command's confirmations — nothing here should be easier to do by accident
 * just because the worktree isn't tracked.
 */
async function removeOrphanCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  if (!(arg instanceof OrphanWorktreeTreeItem)) return;
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) return;

  const { worktreePath, branch } = arg;
  const status = await ctx.status.getStatus(worktreePath);
  const dirty = status.ok && status.value.isDirty;
  const changed = status.ok ? status.value.changedFileCount : 0;

  const keepBranch = "Remove worktree";
  const withBranch = "Remove worktree + branch";
  const detail = [
    branch ? `Branch: ${branch}` : "(detached HEAD)",
    `Path: ${worktreePath}`,
  ].join("\n");

  const choice = await vscode.window.showWarningMessage(
    dirty
      ? `This worktree has ${changed} uncommitted change(s). Removing it will discard them.`
      : `Remove untracked worktree "${branch ?? worktreePath}"?`,
    { modal: true, detail },
    // Only offer branch deletion when there is a branch to delete.
    ...(branch ? [keepBranch, withBranch] : [keepBranch]),
  );
  if (choice !== keepBranch && choice !== withBranch) return;

  const removed = await ctx.worktrees.removeWorktree(repositoryRoot, worktreePath, {
    force: dirty,
  });
  if (!removed.ok) {
    void vscode.window.showErrorMessage(
      `Failed to remove worktree: ${describeWorktreeError(removed.error)}`,
    );
    return;
  }
  ctx.logger.info(`Removed untracked worktree ${worktreePath}`);

  // The branch can only be deleted once its worktree is gone.
  if (choice === withBranch && branch) {
    await deleteOrphanBranch(ctx, repositoryRoot, branch);
  }
  ctx.tree.refresh();
}

/** Deletes an orphan's branch, offering a forced delete if it is unmerged. */
async function deleteOrphanBranch(
  ctx: CommandContext,
  repositoryRoot: string,
  branch: string,
): Promise<void> {
  let res = await ctx.worktrees.deleteBranch(repositoryRoot, branch, { force: false });
  if (!res.ok && res.error.kind === "unmerged") {
    const del = "Delete anyway";
    const confirm = await vscode.window.showWarningMessage(
      `Branch "${branch}" has commits not merged elsewhere. Delete it anyway?`,
      { modal: true, detail: "These commits will be lost." },
      del,
    );
    if (confirm !== del) return;
    res = await ctx.worktrees.deleteBranch(repositoryRoot, branch, { force: true });
  }
  if (!res.ok) {
    void vscode.window.showErrorMessage(
      `Worktree removed, but branch "${branch}" could not be deleted: ${describeWorktreeError(res.error)}`,
    );
  }
}

/** Opens the worktree's solution in Visual Studio. */
async function openInVisualStudioCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  const detected = await ctx.visualStudio.detect(task.worktreePath);
  // Fall back to the worktree itself: VS can open a folder, and this keeps the
  // command useful if detection came up empty but the user knows better.
  const target = detected?.solution
    ? path.join(task.worktreePath, detected.solution)
    : task.worktreePath;

  const devenv = await ctx.visualStudio.findDevenv();
  if (!devenv) {
    // No Visual Studio found — offer the shell's own association rather than
    // failing outright, since .sln may still be registered to something.
    const open = "Open with default app";
    const choice = await vscode.window.showWarningMessage(
      "Visual Studio was not found on this machine.",
      open,
    );
    if (choice === open) await vscode.env.openExternal(vscode.Uri.file(target));
    return;
  }

  try {
    // Detached and unref'd: Visual Studio outlives this window, and we must not
    // hold the extension host open waiting on it.
    const child = spawn(devenv, [target], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    ctx.logger.info(`Opened ${target} in ${devenv}`);
  } catch (error) {
    ctx.logger.error("Failed to launch Visual Studio", error);
    void vscode.window.showErrorMessage("Failed to launch Visual Studio.");
  }
}

/** Reveals the worktree folder in the OS file manager. */
async function revealInExplorerCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  // VS Code's own command, so it uses the right file manager per platform.
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(task.worktreePath));
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

/**
 * Asks what to do about Claude sessions already live in this worktree that we
 * don't own. Returns a session id to adopt, "" to start a fresh session
 * alongside, or undefined to cancel.
 *
 * Never offers to kill anything: these are just as likely to be the user's own
 * terminal sessions as a leftover from a previous window, and terminating one
 * by pid would silently destroy in-flight work.
 */
async function promptForeignSession(
  sessions: LiveAgentSession[],
): Promise<string | undefined> {
  const describe = (s: LiveAgentSession) =>
    `${s.name} · ${s.kind} · started ${new Date(s.startedAt).toLocaleTimeString()}`;

  const startNew = "Start a separate session";
  const items = [
    ...sessions.map((s) => ({
      label: `$(debug-continue) Continue "${s.name}"`,
      description: describe(s),
      detail: "Resume this conversation in the chat panel.",
      sessionId: s.sessionId,
    })),
    {
      label: `$(add) ${startNew}`,
      description: "Leave the existing session running",
      detail: "Starts a new conversation alongside it in the same worktree.",
      sessionId: "",
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title:
      sessions.length === 1
        ? "A Claude session is already running in this worktree"
        : `${sessions.length} Claude sessions are already running in this worktree`,
    placeHolder: "Continue an existing conversation, or start a separate one",
    ignoreFocusOut: true,
  });
  return picked?.sessionId;
}

async function startChatSession(
  ctx: CommandContext,
  task: TaskWorkspace,
): Promise<void> {
  // Opening involves a CLI query, a file scan and a transcript read, none of
  // which show anything until the panel appears — so report progress rather
  // than leaving the click looking ignored.
  const progress = new OpenProgress(`Opening chat — ${task.name}`);
  try {
    await openChatSession(ctx, task, progress);
  } finally {
    // Never leave the indicator spinning if a step throws.
    progress.done();
  }
}

async function openChatSession(
  ctx: CommandContext,
  task: TaskWorkspace,
  progress: OpenProgress,
): Promise<void> {
  // Independent work: the options scan doesn't depend on which session we end
  // up using, so don't pay for it serially.
  progress.report("checking for a running session…");
  const [options, resolved] = await Promise.all([
    buildChatOptions(ctx, task),
    // Query -> reuse -> create. Reusing our own live session just reveals its
    // panel; a session we don't own is surfaced so the user can adopt it instead
    // of unknowingly running two agents in the same worktree.
    ctx.sessions.resolveSession(task.id, task.worktreePath),
  ]);
  if (resolved.kind === "reuse") {
    progress.done();
    AgentChatPanel.show(task.id, task.name, resolved.session, ctx.extensionUri, options);
    return;
  }
  if (ctx.sessions.get(task.id)) ctx.sessions.stop(task.id); // clear a dead session

  let adoptSessionId: string | undefined;
  if (resolved.kind === "foreign") {
    // The prompt is the user's turn — don't spin behind their own dialog.
    progress.done();
    const choice = await promptForeignSession(resolved.sessions);
    if (choice === undefined) return; // cancelled
    adoptSessionId = choice;
    progress.restart("starting…");
  }

  // Continue a prior Claude session for this task if one was persisted to disk.
  // Resuming an id with no transcript fails permanently, so only pass it when
  // the transcript actually exists.
  const priorSessionId =
    task.agent?.provider === "claude-chat" ? task.agent.sessionId : undefined;
  // Adopting a discovered session takes precedence over the recorded one.
  const candidateId = adoptSessionId ?? priorSessionId;
  const resumeSessionId =
    candidateId && transcriptExists(os.homedir(), candidateId) ? candidateId : undefined;

  // No initial prompt is required — the panel opens ready and the user types
  // the first message there.
  const permissionMode = ctx.configuration.permissionMode(ctx.repositoryUri());
  const session = ctx.sessions.getOrStart(task.id, {
    worktreePath: task.worktreePath,
    permissionMode,
    addDirs: [task.repositoryRoot],
    resumeSessionId,
    autoCompactThreshold: ctx.configuration.autoCompactThreshold(ctx.repositoryUri()),
    model: ctx.configuration.model(ctx.repositoryUri()),
  });

  // Replay the prior transcript into the panel so history is visible.
  if (resumeSessionId && session.items.length === 0) {
    progress.report("loading conversation history…");
    const prior = await loadTranscriptItems(os.homedir(), resumeSessionId);
    if (prior.length > 0) session.items.unshift(...prior);
    // Logged so a "history is missing" report can be checked against what was
    // actually on disk, rather than guessed at.
    logReplay(ctx, resumeSessionId, prior);
  }

  const agentSession = {
    provider: "claude-chat",
    sessionId: session.id,
    status: "running" as const,
    startedAt: new Date().toISOString(),
  };
  await ctx.repository.save({ ...task, agent: agentSession, updatedAt: new Date().toISOString() });
  ctx.tree.refresh();

  progress.done();
  AgentChatPanel.show(task.id, task.name, session, ctx.extensionUri, options);
}

/**
 * A status-bar progress indicator for opening a chat, with a message that can
 * be updated as the steps run.
 *
 * Status-bar rather than a notification: opening is usually quick, and a toast
 * for every click would be worse than the silence it replaces. It resolves on
 * `done()`, which every exit path must call.
 */
class OpenProgress {
  private update: ((message: string) => void) | undefined;
  private finish: (() => void) | undefined;

  constructor(private readonly title: string) {
    this.start("");
  }

  private start(message: string): void {
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: this.title },
      (p) =>
        new Promise<void>((resolve) => {
          this.update = (m) => p.report({ message: m });
          this.finish = resolve;
          if (message) p.report({ message });
        }),
    );
  }

  report(message: string): void {
    this.update?.(message);
  }

  /** Shows the indicator again after it was dismissed for a user prompt. */
  restart(message: string): void {
    if (!this.finish) this.start(message);
    else this.report(message);
  }

  done(): void {
    this.finish?.();
    this.finish = undefined;
    this.update = undefined;
  }
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
  let model = ctx.configuration.model(ctx.repositoryUri());

  const startResumed = (resumeSessionId: string | undefined) => {
    const prior = ctx.sessions.get(task.id);
    const carried = prior ? [...prior.items] : [];
    // Only resume a session that was actually persisted. Resuming an id with no
    // transcript on disk fails permanently ("No conversation found"), which is
    // exactly what happens when the very first turn errored before any save —
    // so fall back to a fresh session, carrying the in-memory transcript.
    const resumable =
      resumeSessionId && transcriptExists(os.homedir(), resumeSessionId)
        ? resumeSessionId
        : undefined;
    const session = ctx.sessions.create(task.id, {
      worktreePath: task.worktreePath,
      permissionMode: mode,
      addDirs: [task.repositoryRoot],
      resumeSessionId: resumable,
      autoCompactThreshold: ctx.configuration.autoCompactThreshold(ctx.repositoryUri()),
      model,
    });
    if (session.items.length === 0) {
      const fromDisk = resumeSessionId ? loadTranscriptItemsSync(os.homedir(), resumeSessionId) : [];
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
    currentModel: () => model,
    setModel: (m) => {
      model = m;
      // Persist so subsequent chats in this project default to the chosen model.
      void ctx.configuration.setModel(model, ctx.repositoryUri());
      const current = ctx.sessions.get(task.id);
      return startResumed(current?.id ?? (task.agent?.provider === "claude-chat" ? task.agent.sessionId : undefined));
    },
    resume: () => {
      const current = ctx.sessions.get(task.id);
      return startResumed(current?.id ?? (task.agent?.provider === "claude-chat" ? task.agent.sessionId : undefined));
    },
    // Deliberately does not go through startResumed: no --resume and no
    // carried-over items, so a wedged session can't poison the new one.
    newSession: () => {
      const session = ctx.sessions.create(task.id, {
        worktreePath: task.worktreePath,
        permissionMode: mode,
        addDirs: [task.repositoryRoot],
        autoCompactThreshold: ctx.configuration.autoCompactThreshold(ctx.repositoryUri()),
        model,
      });
      void ctx.repository.save({
        ...task,
        agent: { provider: "claude-chat", sessionId: session.id, status: "running", startedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
      ctx.tree.refresh();
      return session;
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
