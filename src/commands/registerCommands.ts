import * as vscode from "vscode";
import { ApprovalScope } from "../domain/permissionGatePolicy";
import {
  CommandContext,
  PENDING_NATIVE_CHAT_KEY,
  CLAUDE_EXTENSION_ID,
} from "./commandContext";
import { createTaskWorkspaceCommand } from "./createTaskWorkspaceCommand";
import {
  TaskWorkspaceTreeItem,
  OrphanWorktreeTreeItem,
  StageTreeItem,
  ChecklistTreeItem,
  DenialTreeItem,
  HeldCallTreeItem,
} from "../ui/taskWorkspaceTreeItem";
import {
  answerQuestion,
  approveStage,
  clearDenials,
  clearQuestion,
  grantDenial,
  outstandingChecklist,
  setChecklistItem,
  unansweredQuestions,
  ungrantedDenials,
} from "../domain/pipelineEngine";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { AgentChatPanel, ChatPanelOptions, ChatController, HistoryEntry } from "../ui/agentChatPanel";
import { providerVisual } from "../agents/agentProviderMeta";
import { scanSlashCommands } from "../agents/slashCommands";
import { formatReviewPlan } from "../services/reviewPlanService";
import { HARNESS_CONFIG_RELATIVE_PATH } from "../services/reviewRulesService";
import {
  RULE_TEMPLATES,
  renderRuleTemplate,
} from "../domain/reviewRuleTemplates";
import * as fs from "node:fs";
import {
  loadTranscriptItems,
  loadTranscriptItemsSync,
  listSessions,
  transcriptExists,
} from "../agents/transcriptReader";
import { LiveAgentSession } from "../agents/claudeAgents";
import { ChatItem } from "../agents/streamJson";
import { resolveMcpConfigPath } from "../agents/claudeCliArgs";
import { PermissionDenial } from "../agents/permissionDenials";
import { withStatus } from "../ui/statusProgress";
import { QuestionPanel } from "../ui/questionPanel";
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
    register("taskWorkspaces.requiredReviews", (arg) =>
      requiredReviewsCommand(ctx, arg),
    ),
    register("taskWorkspaces.createReviewRules", () =>
      createReviewRulesCommand(ctx),
    ),
    register("taskWorkspaces.advanceRoute", (arg) => advanceRouteCommand(ctx, arg)),
    register("taskWorkspaces.approveStage", (arg) => approveStageCommand(ctx, arg)),
    register("taskWorkspaces.answerQuestions", (arg) => openQuestionsCommand(ctx, arg)),
    register("taskWorkspaces.grantDenial", (arg) => grantDenialCommand(ctx, arg)),
    register("taskWorkspaces.allowAllDenials", (arg) => allowAllDenialsCommand(ctx, arg)),
    register("taskWorkspaces.dismissDenial", (arg) => dismissDenialCommand(ctx, arg)),
    register("taskWorkspaces.decideHeldCall", (arg) => decideHeldCallCommand(ctx, arg)),
    register("taskWorkspaces.approveHeldCall", (arg) =>
      answerHeldCall(ctx, arg, "allow", "session"),
    ),
    register("taskWorkspaces.approveHeldCallOnce", (arg) =>
      answerHeldCall(ctx, arg, "allow", "once"),
    ),
    register("taskWorkspaces.denyHeldCall", (arg) =>
      answerHeldCall(ctx, arg, "deny", "session"),
    ),
    register("taskWorkspaces.toggleChecklistItem", (arg) =>
      toggleChecklistItemCommand(ctx, arg),
    ),
  ];
}

/**
 * Offers the choices for a tool call the agent is currently blocked on.
 *
 * A quick pick rather than a modal or a webview: the agent is paused, so this
 * wants to be answerable in one keystroke, and it must not steal focus from
 * whatever the user is reading. "Always allow" is offered last and only when a
 * rule can actually be derived — a rule that would never match again is the noise
 * the previous version of this generated.
 */
async function decideHeldCallCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof HeldCallTreeItem)) return;
  const gate = ctx.permissionGate;
  if (!gate) return;

  type Choice = vscode.QuickPickItem & {
    decision?: "allow" | "deny";
    scope?: ApprovalScope;
  };

  const choices: Choice[] = [
    {
      label: "$(check) Allow for this task",
      description: "and stop asking about this capability",
      detail: "Nothing is written to disk; the approval lasts until the window closes.",
      decision: "allow",
      scope: "session",
    },
    {
      label: "$(debug-step-over) Allow once",
      description: "just this call",
      decision: "allow",
      scope: "once",
    },
    {
      label: "$(circle-slash) Deny",
      description: "the agent is told it may not do this",
      detail: "It will work around it or say why it cannot continue.",
      decision: "deny",
      scope: "session",
    },
  ];
  if (arg.rule) {
    choices.push({
      label: "$(law) Always allow",
      description: arg.rule,
      detail: "Adds the rule to .claude/settings.local.json, so future tasks skip this.",
      decision: "allow",
      scope: "always",
    });
  }

  const picked = await vscode.window.showQuickPick(choices, {
    title: `${arg.held.request.toolName} is waiting`,
    placeHolder: arg.held.detail,
    ignoreFocusOut: true,
  });
  if (!picked?.decision) return;

  await answerHeldCall(ctx, arg, picked.decision, picked.scope ?? "once");
}

/**
 * Answers a held call, and for "always" writes the rule too.
 *
 * The decision reaches the waiting hook through the gate's inbox, so the agent
 * continues from exactly where it stopped. Nothing here re-runs a stage: that was
 * the cost of the old after-the-fact flow, and removing it is the point.
 */
async function answerHeldCall(
  ctx: CommandContext,
  arg: unknown,
  decision: "allow" | "deny",
  scope: ApprovalScope,
): Promise<void> {
  if (!(arg instanceof HeldCallTreeItem)) return;
  const gate = ctx.permissionGate;
  if (!gate) return;

  if (scope === "always" && arg.rule) {
    const written = ctx.permissionRules.addAllowRules(arg.task.repositoryRoot, [
      arg.rule,
    ]);
    if (written.problem) {
      // Answer the call anyway: the agent is blocked, and failing to write a
      // convenience rule is no reason to leave it that way.
      void vscode.window.showErrorMessage(
        `${written.problem} The call was still allowed for this task.`,
      );
      gate.decide(arg.held.request.id, decision, "session");
      ctx.tree.refresh();
      return;
    }
    // The worktree gets its own copy of the settings file, so refresh it or the
    // rule only takes effect for tasks created afterwards.
    ctx.provisioner.provision(
      ctx.configuration.copyIntoWorktree(ctx.repositoryUri()),
      arg.task.repositoryRoot,
      arg.task.worktreePath,
    );
  }

  const answered = gate.decide(arg.held.request.id, decision, scope);
  if (!answered) {
    // The CLI gave up waiting, or the stage ended. Saying so beats a row that
    // silently does nothing.
    void vscode.window.showWarningMessage(
      "That call is no longer waiting — the stage moved on or timed out.",
    );
  }
  ctx.tree.refresh();
}

/**
 * Notes a refusal and points at the row that can grant it.
 *
 * Deliberately terse: the refusal and its rule are persisted on the pipeline and
 * shown under the stage in the sidebar, so this only has to say it happened. A
 * dismissed notification no longer loses anything.
 */
async function handleDenialCommand(
  ctx: CommandContext,
  task: TaskWorkspace,
  denials: readonly PermissionDenial[],
  stageName: string | undefined,
): Promise<void> {
  const attempts = denials.reduce((total, d) => total + d.attempts, 0);
  const choice = await vscode.window.showWarningMessage(
    `${denials.length} tool call(s) denied in "${stageName ?? task.name}"` +
      (attempts > denials.length ? ` after ${attempts} attempts` : "") +
      ". Approve them under the stage in the sidebar.",
    "Reveal",
    "Show Log",
  );
  if (choice === "Show Log") ctx.logger.show?.();
  if (choice === "Reveal") {
    await vscode.commands.executeCommand("taskWorkspaces.tree.focus");
  }
}

/**
 * Grants one refused call: writes its rule, marks it granted, and offers to
 * carry on. The rule goes to the repository root, so it applies to every future
 * task rather than only this worktree.
 */
async function grantDenialCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  if (!(arg instanceof DenialTreeItem)) return;
  const task = await ctx.repository.get(arg.task.id);
  if (!task?.pipeline?.pendingDenials) return;

  const item = task.pipeline.pendingDenials.items.find((i) => i.id === arg.denial.id);
  if (!item) return;
  if (!item.rule) {
    void vscode.window.showWarningMessage(
      "No rule could be derived from that call — grant it by hand in .claude/settings.local.json.",
    );
    return;
  }

  const written = ctx.permissionRules.addAllowRules(task.repositoryRoot, [item.rule]);
  if (written.problem) {
    void vscode.window.showErrorMessage(written.problem);
    return;
  }

  // The settings file is copied into a worktree at creation, so an existing one
  // needs it refreshed before a retry can see the new rule.
  const provisioned = ctx.provisioner.provision(
    ctx.configuration.copyIntoWorktree(ctx.repositoryUri()),
    task.repositoryRoot,
    task.worktreePath,
  );
  if (provisioned.problems.length > 0) {
    ctx.logger.warn(
      `Could not refresh worktree settings for "${task.name}": ${provisioned.problems.join("; ")}`,
    );
  }

  const granted = grantDenial(task.pipeline, item.id);
  if (granted.ok) {
    await ctx.repository.save({
      ...task,
      pipeline: granted.value,
      updatedAt: new Date().toISOString(),
    });
  }
  ctx.tree.refresh();
  ctx.logger.info(`Harness [${task.name}] allowed ${item.rule}`);

  const latest = await ctx.repository.get(task.id);
  const outstanding = latest?.pipeline ? ungrantedDenials(latest.pipeline) : [];
  if (outstanding.length > 0) {
    void vscode.window.showInformationMessage(
      `Allowed. ${outstanding.length} still to approve.`,
    );
    return;
  }

  const next = await vscode.window.showInformationMessage(
    "Allowed. Nothing else is waiting on approval.",
    "Advance Route",
  );
  if (next === "Advance Route") {
    // Clear them now: the route is about to re-run the step that was refused.
    if (latest?.pipeline) {
      await ctx.repository.save({
        ...latest,
        pipeline: clearDenials(latest.pipeline),
        updatedAt: new Date().toISOString(),
      });
      ctx.tree.refresh();
    }
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/**
 * Grants every outstanding refusal at once, then offers to advance.
 *
 * Worth having as one action because retrying is not free: the subtask re-runs
 * in a fresh session from the beginning, so approving one rule and advancing,
 * then approving the next and advancing again, pays for the stage twice over.
 * Granting them together costs one re-run.
 */
async function allowAllDenialsCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task?.pipeline?.pendingDenials) {
    void vscode.window.showInformationMessage("Nothing is waiting for approval.");
    return;
  }

  const outstanding = ungrantedDenials(task.pipeline);
  const rules = outstanding.map((item) => item.rule).filter((r): r is string => !!r);
  const unmappable = outstanding.length - rules.length;

  if (rules.length === 0) {
    void vscode.window.showWarningMessage(
      "No rules could be derived from those calls — grant them by hand in .claude/settings.local.json.",
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Allow ${rules.length} command(s) for this project?`,
    { modal: true, detail: rules.join("\n") },
    "Allow",
  );
  if (confirm !== "Allow") return;

  const written = ctx.permissionRules.addAllowRules(task.repositoryRoot, rules);
  if (written.problem) {
    void vscode.window.showErrorMessage(written.problem);
    return;
  }
  ctx.provisioner.provision(
    ctx.configuration.copyIntoWorktree(ctx.repositoryUri()),
    task.repositoryRoot,
    task.worktreePath,
  );

  let pipeline = task.pipeline;
  for (const item of outstanding) {
    if (!item.rule) continue;
    const granted = grantDenial(pipeline, item.id);
    if (granted.ok) pipeline = granted.value;
  }
  // Everything grantable is granted, so the record has served its purpose.
  if (unmappable === 0) pipeline = clearDenials(pipeline);

  await ctx.repository.save({
    ...task,
    pipeline,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(
    `Harness [${task.name}] allowed ${written.added.length} rule(s): ${rules.join(", ")}`,
  );

  const next = await vscode.window.showInformationMessage(
    `Allowed ${rules.length} command(s).` +
      (unmappable > 0 ? ` ${unmappable} could not be turned into a rule.` : "") +
      " Advancing re-runs the step that was refused.",
    "Advance Route",
  );
  if (next === "Advance Route") {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/** Drops a refusal without granting it, when the stage can manage without. */
async function dismissDenialCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  if (!(arg instanceof DenialTreeItem)) return;
  const task = await ctx.repository.get(arg.task.id);
  if (!task?.pipeline?.pendingDenials) return;

  const remaining = task.pipeline.pendingDenials.items.filter(
    (i) => i.id !== arg.denial.id,
  );
  const pipeline =
    remaining.length > 0
      ? {
          ...task.pipeline,
          pendingDenials: { ...task.pipeline.pendingDenials, items: remaining },
        }
      : clearDenials(task.pipeline);

  await ctx.repository.save({
    ...task,
    pipeline,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
}

/**
 * Opens the panel for a task's outstanding questions.
 *
 * Reachable from the tree as well as from an advance, because a question now
 * outlives the moment it was asked — the previous dialog was the only way to see
 * it, so dismissing it meant re-running the stage to find out what it wanted.
 */
async function openQuestionsCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task?.pipeline?.pendingQuestion) {
    void vscode.window.showInformationMessage(
      task ? `"${task.name}" has no outstanding questions.` : "No task selected.",
    );
    return;
  }

  QuestionPanel.show(task.id, task.name, task.pipeline.pendingQuestion, {
    // Saved as the user types, so closing the panel cannot lose an answer.
    answer: async (taskId, itemId, text) => {
      const latest = await ctx.repository.get(taskId);
      if (!latest?.pipeline) return;
      const result = answerQuestion(latest.pipeline, itemId, text);
      if (!result.ok) return;
      await ctx.repository.save({
        ...latest,
        pipeline: result.value,
        updatedAt: new Date().toISOString(),
      });
    },
    submit: async (taskId) => {
      const latest = await ctx.repository.get(taskId);
      const pending = latest?.pipeline?.pendingQuestion;
      if (!latest?.pipeline || !pending) return;

      const outstanding = unansweredQuestions(latest.pipeline);
      if (outstanding.length > 0) {
        void vscode.window.showWarningMessage(
          `${outstanding.length} question(s) still need an answer.`,
        );
        return;
      }

      // Answers go into the brief, not back into the session that asked: that
      // session has ended, and the next attempt is a fresh one that sees only
      // the brief. Pairing each answer with its question is why they are stored
      // as items rather than one block of text.
      const transcript = pending.items
        .map((item) => `Q: ${item.text}\nA: ${item.answer?.trim() ?? ""}`)
        .join("\n\n");

      await ctx.repository.save({
        ...latest,
        description: [latest.description, transcript].filter(Boolean).join("\n\n"),
        pipeline: clearQuestion(latest.pipeline),
        updatedAt: new Date().toISOString(),
      });
      QuestionPanel.update(taskId, undefined);
      ctx.tree.refresh();
      ctx.logger.info(
        `Harness [${latest.name}] answered ${pending.items.length} question(s) for "${pending.stageName}".`,
      );

      const next = await vscode.window.showInformationMessage(
        `Added ${pending.items.length} answer(s) to the brief.`,
        "Advance Route",
      );
      if (next === "Advance Route") {
        await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", taskId);
      }
    },
  });
}

/**
 * Approves a stage held at a human gate. The engine refuses while verification
 * items are outstanding, so this reports which ones rather than forcing through.
 */
async function approveStageCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof StageTreeItem)) return;
  const task = await ctx.repository.get(arg.task.id);
  if (!task?.pipeline) return;

  const result = approveStage(task.pipeline, arg.stage.id, new Date().toISOString());
  if (!result.ok) {
    const choice = await vscode.window.showWarningMessage(
      result.error.message,
      "Show Details",
    );
    if (choice === "Show Details") ctx.logger.show?.();
    return;
  }

  await ctx.repository.save({
    ...task,
    pipeline: result.value,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(`Harness [${task.name}] approved "${arg.stage.name}".`);

  const next = await vscode.window.showInformationMessage(
    `Approved "${arg.stage.name}".`,
    "Advance Route",
  );
  if (next === "Advance Route") {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/** Ticks or un-ticks one verification item, optionally recording what was seen. */
async function toggleChecklistItemCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof ChecklistTreeItem)) return;
  const task = await ctx.repository.get(arg.task.id);
  if (!task?.pipeline) return;

  const checking = !arg.item.checked;
  let note: string | undefined;
  if (checking) {
    // Optional, but the observation is the evidence — worth capturing while the
    // tester still remembers it.
    note = await vscode.window.showInputBox({
      title: arg.item.text,
      prompt: "What did you observe? (optional)",
      placeHolder: "e.g. Verified on staging — dealer id retained",
    });
  }

  const result = setChecklistItem(task.pipeline, arg.item.id, {
    checked: checking,
    note,
    at: new Date().toISOString(),
  });
  if (!result.ok) {
    void vscode.window.showErrorMessage(result.error.message);
    return;
  }

  await ctx.repository.save({
    ...task,
    pipeline: result.value,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();

  const remaining = outstandingChecklist(result.value).length;
  if (checking && remaining === 0) {
    void vscode.window.showInformationMessage(
      "All verification items are checked — the human gate can now be approved.",
    );
  }
}

/**
 * Drives a harnessed task's route as far as it can go unattended, stopping at the
 * first human gate or failure. Cancellable, because each step spawns an agent
 * session and the whole run can take many minutes.
 */
async function advanceRouteCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  if (!task.pipeline) {
    void vscode.window.showInformationMessage(
      `"${task.name}" has no route, so there is nothing to advance.`,
    );
    return;
  }

  if (ctx.runner.isRunning(task.id)) {
    void vscode.window.showInformationMessage(
      `"${task.name}" is already advancing. Stop the agent to interrupt it.`,
    );
    return;
  }

  // Status-bar progress, not a notification. A route runs for many minutes and
  // several can run at once; one dismissable toast per task would bury the ones
  // that actually need an answer. The sidebar already shows which stage and
  // subtask each task is on, and Stop Agent is the cancel affordance — so only
  // outcomes that need a human get a notification, below.
  const report = await withStatus(`Advancing "${task.name}"`, (step) => {
    step("asking the engine what is next");
    return ctx.runner.advance(task);
  });

  ctx.tree.refresh();
  for (const step of report.steps) {
    ctx.logger.info(`Harness [${task.name}] ${step}`);
  }

  const outcome = report.outcome;

  // A refusal takes precedence over every other reading of the run: the stage did
  // not do what it set out to do, and only the user can grant the permission.
  if (outcome.kind === "denied") {
    await handleDenialCommand(ctx, task, outcome.denials, outcome.stageName);
    return;
  }
  // Pausing can be switched off, in which case the refusal is still reported —
  // it just does not stop the route.
  if (report.denials.length > 0) {
    await handleDenialCommand(ctx, task, report.denials, undefined);
  }

  switch (outcome.kind) {
    case "cancelled":
      // The user stopped it; they know. Saying so again is noise.
      ctx.logger.info(`Harness [${task.name}] stopped; the route can be resumed.`);
      return;
    case "done":
      void vscode.window.showInformationMessage(
        `"${task.name}" completed its route.`,
      );
      return;
    case "needsInput":
      // The questions are already persisted on the pipeline by the runner, so
      // this only opens the panel. Closing it loses nothing — the task shows an
      // "Answer Questions" action until they are answered.
      ctx.tree.refresh();
      await openQuestionsCommand(ctx, task.id);
      return;
    case "awaitingApproval": {
      const choice = await vscode.window.showInformationMessage(
        `"${task.name}" is waiting for you at "${outcome.stageName}".`,
        "Show Details",
      );
      if (choice === "Show Details") ctx.logger.show?.();
      return;
    }
    case "blocked": {
      const choice = await vscode.window.showWarningMessage(
        `"${task.name}" stopped at "${outcome.stageName}"` +
          (outcome.reason ? `: ${outcome.reason}` : "."),
        "Show Details",
      );
      if (choice === "Show Details") ctx.logger.show?.();
      return;
    }
    case "exhausted":
      void vscode.window.showWarningMessage(
        `"${task.name}" hit the ${outcome.steps}-step limit without finishing. See the log.`,
      );
      return;
    case "unharnessed":
      return;
  }
}

/**
 * Writes a starter review-rules file into the repository. The extension applies
 * no rules of its own, so this is how a project opts in — the copied file is the
 * project's to edit, which is the point.
 */
async function createReviewRulesCommand(ctx: CommandContext): Promise<void> {
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) {
    void vscode.window.showErrorMessage("Open a Git repository first.");
    return;
  }

  const configured = ctx.configuration.harnessConfigPath(ctx.repositoryUri());
  const relative = configured.trim() || HARNESS_CONFIG_RELATIVE_PATH;
  const target = path.isAbsolute(relative)
    ? relative
    : path.join(repositoryRoot, relative);

  if (fs.existsSync(target)) {
    const open = await vscode.window.showInformationMessage(
      `${relative} already exists.`,
      "Open It",
    );
    if (open === "Open It") {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    RULE_TEMPLATES.map((template) => ({
      label: template.label,
      detail: template.description,
      template,
    })),
    {
      title: "Create Review Rules File",
      placeHolder: "Starter rule set — you can edit it afterwards",
    },
  );
  if (!picked) return;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderRuleTemplate(picked.template), "utf8");
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not write ${relative}: ${(error as Error).message}`,
    );
    return;
  }

  ctx.logger.info(`Created review rules at ${target} from the "${picked.template.id}" template.`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  void vscode.window.showInformationMessage(
    `Created ${relative}. Commit it on your base branch — the harness config is read from the repository root, not from task worktrees.`,
  );
}

/**
 * Shows which reviews a task's actual diff obliges, per the project's rules.
 * For a harnessed task it also offers to add the missing stages to its pipeline.
 */
async function requiredReviewsCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  const planned = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Evaluating review rules…" },
    () => ctx.reviewPlans.plan(task),
  );
  if (!planned.ok) {
    void vscode.window.showErrorMessage(
      `Could not evaluate review rules: ${planned.error.message}`,
    );
    return;
  }

  const plan = planned.value;
  ctx.logger.info(formatReviewPlan(task, plan));

  if (plan.problems.length > 0) {
    void vscode.window.showWarningMessage(
      `Review rules have ${plan.problems.length} problem(s). See the output channel.`,
    );
  }

  if (plan.required.length === 0) {
    void vscode.window.showInformationMessage(
      plan.changedPaths.length === 0
        ? `"${task.name}" has no changes relative to ${task.baseBranch}.`
        : `No extra reviews required for "${task.name}".`,
    );
    return;
  }

  const missing = plan.required.filter((r) => !r.alreadyOnPipeline);
  const summary = plan.required.map((r) => r.stageLabel).join(", ");

  // An unharnessed task has no pipeline to add stages to, so the answer is
  // advisory only. Say so rather than offering an action that cannot work.
  if (!plan.harnessed) {
    const choice = await vscode.window.showInformationMessage(
      `"${task.name}" requires: ${summary}`,
      { detail: "Advisory only — this task has no route.", modal: false },
      "Show Details",
    );
    if (choice === "Show Details") ctx.logger.show?.();
    return;
  }

  if (missing.length === 0) {
    void vscode.window.showInformationMessage(
      `"${task.name}" already has every required review: ${summary}`,
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `"${task.name}" is missing ${missing.length} required review(s): ${missing
      .map((r) => r.stageLabel)
      .join(", ")}`,
    "Add to Pipeline",
    "Show Details",
  );
  if (choice === "Show Details") {
    ctx.logger.show?.();
    return;
  }
  if (choice !== "Add to Pipeline") return;

  const applied = await ctx.reviewPlans.apply(task);
  if (!applied.ok) {
    void vscode.window.showErrorMessage(
      `Could not update the pipeline: ${applied.error.message}`,
    );
    return;
  }
  ctx.tree.refresh();
  void vscode.window.showInformationMessage(
    `Added ${applied.value.added.length} review stage(s) to "${task.name}".`,
  );
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

/**
 * Context-management options shared by every session launch. The handoff is
 * logged verbatim alongside the brief actually sent, so a checkpoint is
 * inspectable after the fact — otherwise a clear would be unauditable.
 */
function contextOptions(ctx: CommandContext, task: TaskWorkspace) {
  return {
    contextStrategy: ctx.configuration.contextStrategy(ctx.repositoryUri()),
    // Worktrees are unapproved directories, so the project's .mcp.json has to be
    // passed explicitly or none of its servers start.
    mcpConfigPath: resolveMcpConfigPath(
      task.repositoryRoot,
      ctx.configuration.mcpConfigPath(ctx.repositoryUri()),
      (p) => fs.existsSync(p),
    ),
    taskName: task.name,
    onCheckpoint: ({ raw, brief }: { raw: string; brief: string }) => {
      ctx.logger.info(
        `Checkpoint for "${task.name}" — handoff written by the agent:\n${raw}\n\n` +
          `--- brief sent to the fresh session (${brief.length} chars) ---\n${brief}`,
      );
    },
  };
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

  // Removal archives transcripts, stops the agent and shells out to git, none of
  // which reported anything — so a slow `git worktree remove` was
  // indistinguishable from a click that had not registered.
  const result = await withStatus(`Removing "${task.name}"`, async (step) => {
    // Preserve Claude history before the worktree (and its transcripts) vanish.
    step("archiving agent transcripts");
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

    // Cancel the route first: stopping only the session ends the current subtask,
    // which the driver reads as a finished turn and answers by starting the next
    // one — against a worktree that is about to be deleted.
    step("stopping the agent");
    ctx.runner.cancel(task.id);
    ctx.sessions.stop(task.id);
    ctx.terminals.disposeTerminal(task.id);

    step("removing the worktree");
    return ctx.service.removeTask(task.id, { force });
  });
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
  // Each git call gets its own status-bar item, so the confirmation below sits
  // between them rather than under a spinner.
  let res = await withStatus(`Deleting ${task.branchName}`, () =>
    ctx.worktrees.deleteBranch(task.repositoryRoot, task.branchName, { force: false }),
  );
  if (!res.ok && res.error.kind === "unmerged") {
    const choice = await vscode.window.showWarningMessage(
      `Branch "${task.branchName}" has commits not merged elsewhere. Delete it anyway?`,
      { modal: true, detail: "These commits will be lost." },
      "Delete Branch",
    );
    if (choice !== "Delete Branch") return;
    res = await withStatus(`Force-deleting ${task.branchName}`, () =>
      ctx.worktrees.deleteBranch(task.repositoryRoot, task.branchName, { force: true }),
    );
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
    ...contextOptions(ctx, task),
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
      ...contextOptions(ctx, task),
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
        ...contextOptions(ctx, task),
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

  // Stop the route before the session. Stopping only the session ends the current
  // subtask, which the driver reads as "that turn finished" and answers by
  // starting the next one — so a stop that did not cancel the route was not a
  // stop at all. Cancelling first means the reply is discarded and the subtask
  // reverts to pending, so Advance Route resumes from where it stopped.
  ctx.runner.cancel(task.id);
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
