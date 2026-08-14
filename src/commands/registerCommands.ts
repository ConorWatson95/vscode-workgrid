import * as vscode from "vscode";
import { ApprovalScope } from "../domain/permissionGatePolicy";
import { changeRows, changeSummary } from "../ui/changeList";
import { ok } from "../utilities/result";
import {
  correctStage,
  ruleInsertionIndex,
  undoCorrection,
  undoableCorrection,
} from "../domain/pipelineEngine";
import { itemsForGate } from "../domain/checklistScope";
import {
  refreshPendingStages,
  addMissingStages,
  revertToStage,
  sendBackTargets,
  sendBackToStage,
  formatSendBackNote,
  repositionRuleStages,
  repositionRouteStages,
  syncHandoffs,
} from "../domain/stageRefresh";
import { approvalAdvice } from "../domain/approvalAdvice";
import { deferralHeadline, isAbridged } from "../domain/deferralText";
import { rowTask } from "../ui/rowTask";
import { HANDOFF_EXPERIMENT } from "../domain/pipelineExperiment";
import {
  formatFindings,
  parseReviewFindings,
  summariseFindings,
} from "../domain/reviewFindings";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";
import {
  CommandContext,
  PENDING_NATIVE_CHAT_KEY,
  CLAUDE_EXTENSION_ID,
} from "./commandContext";
import { createTaskWorkspaceCommand } from "./createTaskWorkspaceCommand";
import {
  linkSuggestionToTaskCommand,
  openSuggestionCommand,
  scanForWorkCommand,
  startTaskFromSuggestionCommand,
  unlinkTaskOriginCommand,
} from "./suggestionCommands";
import { mergeIntoTaskCommand } from "./mergeIntoTaskCommand";
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
  checkOutstandingChecklist,
  outstandingDeferrals,
  resolveDeferral,
  setChecklistItem,
  unansweredQuestions,
  ungrantedDenials,
  createPipeline,
} from "../domain/pipelineEngine";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { AgentChatPanel, ChatPanelOptions, ChatController, HistoryEntry } from "../ui/agentChatPanel";
import { providerVisual } from "../agents/agentProviderMeta";
import { scanSlashCommands } from "../agents/slashCommands";
import { formatReviewPlan } from "../services/reviewPlanService";
import { HARNESS_CONFIG_RELATIVE_PATH, loadHarness } from "../services/reviewRulesService";
import { RouteDefinition, assessmentStageDefinition } from "../domain/taskRoute";
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
    register("taskWorkspaces.scanForWork", () => scanForWorkCommand(ctx)),
    register("taskWorkspaces.startTaskFromSuggestion", (arg) =>
      startTaskFromSuggestionCommand(ctx, arg),
    ),
    register("taskWorkspaces.openSuggestion", (arg) => openSuggestionCommand(arg)),
    register("taskWorkspaces.linkSuggestionToTask", (arg) =>
      linkSuggestionToTaskCommand(ctx, arg),
    ),
    register("taskWorkspaces.unlinkTaskOrigin", (arg) => unlinkTaskOriginCommand(ctx, arg)),
    register("taskWorkspaces.toggleHiddenSuggestions", () => {
      const showing = ctx.tree.toggleHiddenSuggestions();
      void vscode.commands.executeCommand(
        "setContext",
        "taskWorkspaces.showHiddenSuggestions",
        showing,
      );
    }),
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
    register("taskWorkspaces.attachRoute", (arg) => attachRouteCommand(ctx, arg)),
    register("taskWorkspaces.adoptBranch", () => adoptBranchCommand(ctx)),
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
    register("taskWorkspaces.checkoutTaskBranch", (arg) =>
      checkoutTaskBranchCommand(ctx, arg),
    ),
    register("taskWorkspaces.mergeIntoTask", (arg) => mergeIntoTaskCommand(ctx, arg)),
    register("taskWorkspaces.approveStage", (arg) => approveStageCommand(ctx, arg)),
    register("taskWorkspaces.showStageReport", (arg) => showStageReportCommand(ctx, arg)),
    register("taskWorkspaces.revertToStage", (arg) => revertToStageCommand(ctx, arg)),
    register("taskWorkspaces.correctStage", (arg) => correctStageCommand(ctx, arg)),
    register("taskWorkspaces.undoCorrection", (arg) => undoCorrectionCommand(ctx, arg)),
    register("taskWorkspaces.setExperimentArm", (arg) => setExperimentArmCommand(ctx, arg)),
    register("taskWorkspaces.compareRuns", (arg) => compareRunsCommand(ctx, arg)),
    register("taskWorkspaces.sendBackToStage", (arg) => sendBackToStageCommand(ctx, arg)),
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
    register("taskWorkspaces.verifyAllChecklist", (arg) =>
      verifyAllChecklistCommand(ctx, arg),
    ),
    register("taskWorkspaces.noteChecklistItem", (arg) =>
      noteChecklistItemCommand(ctx, arg),
    ),
    // Also a command, not only a button on the notification that announced it: a
    // notification is dismissable and the hold is not, and a route stopped with no
    // visible way to un-stop it reads as broken.
    register("taskWorkspaces.settleDeferrals", (arg) =>
      settleDeferralsCommand(ctx, taskIdOf(arg)),
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

  const granted = grantDenial(task.pipeline, item.id, new Date().toISOString());
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
    const granted = grantDenial(pipeline, item.id, new Date().toISOString());
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
      const result = answerQuestion(latest.pipeline, itemId, text, new Date().toISOString());
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
      if (!latest?.pipeline || !pending) {
        return { ok: false, reason: "this task is no longer waiting on an answer." };
      }

      const outstanding = unansweredQuestions(latest.pipeline);
      if (outstanding.length > 0) {
        return {
          ok: false,
          reason: `${outstanding.length} question(s) still need an answer.`,
        };
      }

      // A live question is one an agent is still blocked on, so the answers go
      // back to *it* and it carries on mid-turn with everything it had worked
      // out. Nothing re-runs, and nothing needs advancing — the session never
      // stopped. This is the whole reason `ask_user` exists.
      const liveCallId = pending.liveCallId;
      if (liveCallId && ctx.askUser?.get(liveCallId)) {
        const answered = ctx.askUser.answer(
          liveCallId,
          pending.items.map((item) => item.answer?.trim() ?? ""),
        );
        if (answered) {
          await ctx.repository.save({
            ...latest,
            // Kept in the brief as well: a later subtask runs in a fresh session
            // and would otherwise have to ask the same thing again.
            description: [
              latest.description,
              pending.items
                .map((item) => `Q: ${item.text}\nA: ${item.answer?.trim() ?? ""}`)
                .join("\n\n"),
            ]
              .filter(Boolean)
              .join("\n\n"),
            pipeline: clearQuestion(latest.pipeline),
            updatedAt: new Date().toISOString(),
          });
          QuestionPanel.update(taskId, undefined);
          ctx.tree.refresh();
          ctx.logger.info(
            `Harness [${latest.name}] answered ${pending.items.length} question(s) live; the agent is continuing.`,
          );
          return;
        }
        // Fell through: the stage ended or timed out while the panel was open, so
        // the answers are worth keeping and the stage has to run again.
        void vscode.window.showWarningMessage(
          "That stage stopped waiting, so your answers were added to the brief instead.",
        );
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

      // Carry straight on. Answering is deliberate and its only purpose is to
      // unblock the route, so stopping to ask "shall I continue?" only creates a
      // window in which the task sits idle. The panel is closed by then, so the
      // status bar is where the run becomes visible; Stop Agent still interrupts.
      if (ctx.configuration.advanceAfterAnswering(ctx.repositoryUri())) {
        ctx.logger.info(
          `Harness [${latest.name}] advancing automatically after answers.`,
        );
        await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", taskId);
        return;
      }

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
/**
 * Shows what a stage actually did, in a read-only document.
 *
 * A stage session is otherwise invisible: it runs headless, and its reply used to
 * be parsed for a marker and then discarded. A deployment preview that produced
 * pages of output left nothing behind, so the only way to see it was to run the
 * command again by hand.
 */
async function showStageReportCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const stageItem = arg instanceof StageTreeItem ? arg : undefined;
  // Re-read rather than trusting the row: a report opened on a running stage has to
  // render what the task looks like now, not what it looked like when the tree drew.
  const resolved = await resolveTaskOrAsk(ctx, arg, "Show what a task did");
  const task = resolved ? ((await ctx.repository.get(resolved.id)) ?? resolved) : undefined;
  if (!task) return;

  // A stage row reports that stage; the task row reports everything it has done.
  const uri = ctx.reportProvider.uriFor(
    task,
    stageItem ? { id: stageItem.stage.id, name: stageItem.stage.name } : undefined,
  );

  // Opened as a rendered preview over a read-only virtual document, not as an
  // untitled editor holding a snapshot. The snapshot was editable, so closing it
  // asked to save text the user never wrote, and it never moved again — a report
  // opened on a running stage stayed empty while the stage did its work.
  const document = await vscode.workspace.openTextDocument(uri);
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    // The built-in markdown extension can be disabled. The document is still
    // read-only, so the fallback loses the rendering and nothing else.
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

/**
 * Sends a review's findings to an earlier stage as a correction rather than a redo.
 *
 * Shares `formatSendBackNote` with the re-run path deliberately: the text the fixing
 * stage reads is the same text it would have read as guidance, naming the review that
 * raised it. By the time a fix session runs, the reviewing stage's own output has been
 * cleared, so without the attribution the findings arrive from nowhere.
 */
async function applyCorrection(
  ctx: CommandContext,
  task: TaskWorkspace,
  from: TaskStage,
  target: TaskStage,
  input: { findings: string; note?: string; summary: string },
): Promise<void> {
  const finding = formatSendBackNote(from.name, input.findings, input.note);
  const corrected = correctStage(task.pipeline!, target.id, {
    finding,
    at: new Date().toISOString(),
    title: `Fix: ${input.summary}`,
  });
  if (!corrected.ok) {
    void vscode.window.showWarningMessage(corrected.error.message);
    return;
  }

  await ctx.repository.save({
    ...task,
    pipeline: corrected.value,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(
    `Harness [${task.name}] "${target.name}" will fix ${input.summary} from "${from.name}".`,
  );

  if (ctx.configuration.advanceAfterAnswering(ctx.repositoryUri())) {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
    return;
  }
  const next = await vscode.window.showInformationMessage(
    `"${target.name}" will fix ${input.summary} on the next advance.`,
    "Advance Route",
  );
  if (next === "Advance Route") {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/**
 * Fixes one thing in a stage that has already run, instead of re-running it.
 *
 * The alternative was always demolition: `revertToStage` discards the stage and
 * everything after it, so a one-line cast error cost the same as a wrong approach —
 * on one real route, a $12.48 stage re-run from cold to change a type. Which made
 * the rational response to a review finding "do not act on it".
 */
async function correctStageCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  if (!(arg instanceof StageTreeItem)) return;
  const task = await rowPipelineTask(ctx, arg, "correct this stage");
  if (!task) return;

  if (ctx.runner.isRunning(task.id)) {
    void vscode.window.showInformationMessage(
      `"${task.name}" is advancing. Stop it before correcting a stage.`,
    );
    return;
  }

  const stage = task.pipeline.stages.find((s) => s.id === arg.stage.id) ?? arg.stage;
  const finding = await vscode.window.showInputBox({
    title: `What needs fixing in "${stage.name}"?`,
    prompt: "The stage keeps everything else it did and fixes only this.",
    placeHolder:
      'e.g. "Specified cast is not valid" opening the report — the grid reads TotalValue as int',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "Say what is wrong, or press Escape." : undefined,
  });
  if (!finding) return;

  const later = task.pipeline.stages
    .slice(task.pipeline.stages.findIndex((s) => s.id === stage.id) + 1)
    .filter((s) => s.status !== "pending").length;
  const queued = stage.subtasks.filter(
    (subtask) => subtask.correction && subtask.status === "pending",
  ).length;
  const confirmed = await vscode.window.showWarningMessage(
    `Fix this in "${stage.name}"?`,
    {
      modal: true,
      detail:
        `"${stage.name}" keeps what it already produced — its report, its cost and its ` +
        "work — and gets one more session that changes only what you named.\n\n" +
        (later > 0
          ? `${later} later stage(s) will be re-opened, because they ran against output that is about to change.\n\n`
          : "No later stage has run yet, so nothing else is discarded.\n\n") +
        (queued > 0
          ? `${queued} correction(s) are already waiting on this stage; they all run on the next advance.`
          : "Fix It queues it — add more corrections before advancing, and they run together."),
    },
    "Fix It & Advance",
    "Fix It",
  );
  if (confirmed !== "Fix It" && confirmed !== "Fix It & Advance") return;

  const corrected = correctStage(task.pipeline, stage.id, {
    finding,
    at: new Date().toISOString(),
  });
  if (!corrected.ok) {
    void vscode.window.showWarningMessage(corrected.error.message);
    return;
  }

  await ctx.repository.save({
    ...task,
    pipeline: corrected.value,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(`Harness [${task.name}] correcting "${stage.name}": ${finding.trim()}`);

  // Deliberately not `advanceAfterAnswering`: that setting is about answering a
  // question and approving a stage, both of which are single deliberate acts whose
  // only purpose is to unblock the route. A correction is a setup act, and setup acts
  // come in batches — two findings against one stage want one advance, not two, since
  // the first advance runs the stage and re-opens everything after it before the
  // second finding has been filed. Which of the two this is, is known only at the
  // moment of confirming, so it is asked there rather than settled by a preference.
  if (confirmed !== "Fix It & Advance") {
    void vscode.window.showInformationMessage(
      `"${stage.name}" will fix that on the next advance.`,
    );
    return;
  }
  await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
}

/**
 * Withdraws a correction whose finding turned out to be wrong.
 *
 * A finding is often a comment acted on before it was investigated, and until this
 * existed the only ways out were editing the state file or re-running the stage
 * from cold — the demolition `correctStage` was built to avoid, reached from the
 * other side.
 *
 * The dialog says what does *not* come back, at length, because that is the part a
 * reader will otherwise assume: later stages were re-opened when the correction was
 * filed and their runs are gone for good.
 */
async function undoCorrectionCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  if (!(arg instanceof StageTreeItem)) return;
  const task = await rowPipelineTask(ctx, arg, "undo that correction");
  if (!task) return;

  if (ctx.runner.isRunning(task.id)) {
    void vscode.window.showInformationMessage(
      `"${task.name}" is advancing. Stop it before withdrawing a correction.`,
    );
    return;
  }

  const stage = task.pipeline.stages.find((s) => s.id === arg.stage.id) ?? arg.stage;
  const fix = undoableCorrection(stage);
  if (!fix) {
    void vscode.window.showWarningMessage(`"${stage.name}" has no correction to withdraw.`);
    return;
  }

  const ran = Boolean(fix.reply || fix.activity);
  const undo = fix.correction?.undo;
  // Stages that have something to lose. Withdrawing re-opens everything after the
  // target, but a stage that never ran loses nothing and counting it overstates.
  const later = task.pipeline.stages
    .slice(task.pipeline.stages.findIndex((s) => s.id === stage.id) + 1)
    .filter((s) => s.status !== "pending").length;

  const confirmed = await vscode.window.showWarningMessage(
    `Withdraw this correction from "${stage.name}"?`,
    {
      modal: true,
      detail:
        `The finding was: ${fix.correction?.finding ?? fix.title}\n\n` +
        (undo
          ? `"${stage.name}" goes back to ${undo.status}${
              undo.verdict ? ` with its "${undo.verdict}" verdict` : ""
            }, exactly as it stood before the correction was filed.\n\n`
          : `This correction was filed before withdrawals were recorded, so there is no ` +
            `snapshot of how "${stage.name}" stood. It keeps everything it produced and ` +
            `comes back to you awaiting approval, rather than being handed a verdict ` +
            `invented here — read it and approve it as you would have before.\n\n`) +
        (ran
          ? "The correction's own run is removed, and what it cost stays on the record as a discarded run.\n\n"
          : "It had not run yet, so nothing it did is lost.\n\n") +
        (later > 0
          ? `${later} later stage(s) will be re-opened, because they ran against output that ` +
            "is about to change back. Anything they wrote to the worktree stays there — " +
            "the harness never reverts files, so check the worktree before advancing."
          : "No later stage has run, so nothing else is discarded."),
    },
    "Withdraw It",
  );
  if (confirmed !== "Withdraw It") return;

  const undone = undoCorrection(task.pipeline, stage.id, new Date().toISOString());
  if (!undone.ok) {
    void vscode.window.showWarningMessage(undone.error.message);
    return;
  }

  await ctx.repository.save({
    ...task,
    pipeline: undone.value,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(
    `Harness [${task.name}] withdrew correction from "${stage.name}": ${
      fix.correction?.finding ?? fix.title
    }`,
  );
  void vscode.window.showInformationMessage(
    `Withdrew the correction from "${stage.name}".`,
  );
}

/**
 * Puts a task on one side of a comparison, or takes it off.
 *
 * Set before the route runs, and refused once it has started: an arm changed
 * halfway produces a run that is neither side, and the totals still look like a
 * result. That is the one failure this whole facility cannot survive, because
 * nothing about the numbers afterwards shows it happened.
 */
async function setExperimentArmCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  if (!task.pipeline) {
    void vscode.window.showInformationMessage(
      `"${task.name}" has no route, so there is nothing to measure.`,
    );
    return;
  }

  const started = task.pipeline.stages.some(
    (stage) => stage.subtasks.some((subtask) => subtask.startedAt) || stage.startedAt,
  );
  if (started && task.pipeline.experiment) {
    void vscode.window.showWarningMessage(
      `"${task.name}" is already running on the \`${task.pipeline.experiment.arm}\` arm. ` +
        "Changing it now would produce a run that is neither side of the comparison.",
    );
    return;
  }
  if (started) {
    const proceed = await vscode.window.showWarningMessage(
      `"${task.name}" has already run stages with handoffs behaving normally.`,
      { modal: true, detail: "Setting an arm now measures a route that was half of each." },
      "Set Anyway",
    );
    if (proceed !== "Set Anyway") return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "Control",
        detail: "Handoffs carried forward, exactly as the harness normally behaves.",
        arm: "control" as const,
      },
      {
        label: "No handoffs",
        detail:
          "Stages still write their handoff blocks and the pipeline still stores them, " +
          "but later stages are not given them — so each rediscovers what it needs.",
        arm: "no-handoffs" as const,
      },
      {
        label: "None — not part of an experiment",
        detail: "Clears the arm. The run behaves normally and is excluded from comparisons.",
        arm: undefined,
      },
    ],
    {
      title: `Experiment arm for "${task.name}"`,
      placeHolder: "Which side of the handoff comparison is this run?",
    },
  );
  if (!choice) return;

  const note = choice.arm
    ? await vscode.window.showInputBox({
        title: "Anything worth recording about the conditions?",
        placeHolder: "Optional — e.g. 'same ticket as NMGB-2799, rerun from scratch'",
      })
    : undefined;

  await ctx.repository.save({
    ...task,
    pipeline: {
      ...task.pipeline,
      experiment: choice.arm
        ? {
            id: HANDOFF_EXPERIMENT,
            arm: choice.arm,
            at: new Date().toISOString(),
            ...(note?.trim() ? { note: note.trim() } : {}),
          }
        : undefined,
    },
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  void vscode.window.showInformationMessage(
    choice.arm
      ? `"${task.name}" is on the \`${choice.arm}\` arm.`
      : `"${task.name}" is no longer part of an experiment.`,
  );
}

/**
 * Opens two runs side by side.
 *
 * The measurement the harness has been able to describe but not perform: does
 * carrying a stage's conclusion forward cost less than the next stage rediscovering
 * it? Most of what the report does is refuse to mislead — see `runComparison.ts`.
 */
async function compareRunsCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const first = await resolveTask(ctx, arg);
  if (!first) return;
  if (!first.pipeline) {
    void vscode.window.showInformationMessage(
      `"${first.name}" has no route, so there is nothing to compare.`,
    );
    return;
  }

  const repositoryRoot = ctx.resolveRepositoryRoot();
  const others = (await ctx.repository.getByRepository(repositoryRoot ?? "")).filter(
    (task) => task.id !== first.id && task.pipeline,
  );
  if (others.length === 0) {
    void vscode.window.showInformationMessage(
      "There is no other task with a route to compare this one against.",
    );
    return;
  }

  const choice = await vscode.window.showQuickPick(
    others.map((task) => ({
      label: task.name,
      // The arm shown in the picker, not only in the report: picking two runs from
      // the same arm is the mistake that produces a number meaning nothing, and it
      // is much cheaper to prevent here than to explain afterwards.
      description: task.pipeline?.experiment
        ? `arm: ${task.pipeline.experiment.arm}`
        : "no experiment arm",
      detail: task.pipeline?.routeLabel ?? task.pipeline?.routeId,
      task,
    })),
    {
      title: `Compare "${first.name}" against…`,
      placeHolder: "The other run",
    },
  );
  if (!choice) return;

  const uri = ctx.reportProvider.comparisonUriFor(first, choice.task);
  const document = await vscode.workspace.openTextDocument(uri);
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

/**
 * Re-opens a stage that has already run, reloading its definition from config.
 *
 * The case this is for: a stage ran with an instruction that turned out to be
 * wrong, the instruction has been fixed in `harness.json`, and the stage needs
 * doing again. Recreating the task would work but throws away its history and
 * everything already approved.
 */
async function revertToStageCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof StageTreeItem)) return;
  const task = await rowPipelineTask(ctx, arg, "re-run this stage");
  if (!task) return;

  if (ctx.runner.isRunning(task.id)) {
    void vscode.window.showInformationMessage(
      `"${task.name}" is advancing. Stop the agent before reverting.`,
    );
    return;
  }

  const preview = revertToStage(task.pipeline, arg.stage.id);
  if (!preview) return;

  // Asked before the confirmation, because it is the reason for the confirmation.
  //
  // Without it a re-run had no input the operator could change. Everything it reloads
  // comes from `harness.json`, so steering one task meant editing the route every task
  // shares — and the account of what went wrong was usually on the run being discarded,
  // so the new session started cold with the same brief and reached the same answer.
  // Optional, because the original case for this command stands: the instruction was
  // wrong, it has been fixed in config, and there is nothing to add.
  const note = await vscode.window.showInputBox({
    title: `Why is "${arg.stage.name}" being re-run?`,
    prompt:
      "Handed to the new session, and to every stage after it, ranked above the brief. " +
      "Leave empty if the fix was in harness.json.",
    placeHolder:
      'e.g. it copied Phase 2\'s layout; the shape comes from tab 3 of the wireframe',
    ignoreFocusOut: true,
  });
  // Escape means "I have changed my mind", not "no note": the box is the first thing
  // the command shows, so treating dismissal as an empty note would make the only way
  // out of a mis-click a destructive confirmation dialog.
  if (note === undefined) return;

  // Confirmed because it discards work: later stages were built on output that is
  // about to go, and their checklist items with them.
  const also = preview.reopened.length - 1;
  const confirmed = await vscode.window.showWarningMessage(
    `Re-run "${arg.stage.name}"?`,
    {
      modal: true,
      detail:
        (also > 0
          ? `${also} later stage(s) will be re-opened too, because they were built on output this discards. `
          : "") +
        "Recorded output and verification items for those stages are discarded. " +
        "Your approval notes are kept, and stage instructions are reloaded from harness.json." +
        (note.trim()
          ? `\n\nThe new session is told: ${note.trim()}`
          : "\n\nNo reason given, so the new session starts from the same brief as the run being discarded."),
    },
    "Re-run Stage",
  );
  if (confirmed !== "Re-run Stage") return;

  // Re-computed now that it is going ahead, with the discard recorded. The preview
  // above deliberately does not record: the ledger must not gain an entry for a
  // re-run the user looked at and cancelled.
  const reverted = revertToStage(task.pipeline, arg.stage.id, {
    at: new Date().toISOString(),
    reason: "re-run by hand",
    note,
  });
  if (!reverted) return;

  // Reloaded after reverting, not before: the stages that just became pending are
  // exactly the ones whose instructions should come from current config.
  const refreshed = ctx.stageDefinitions
    ? refreshPendingStages(reverted.pipeline, ctx.stageDefinitions())
    : { pipeline: reverted.pipeline, changed: [] as string[] };

  await ctx.repository.save({
    ...task,
    pipeline: refreshed.pipeline,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(
    `Harness [${task.name}] reverted to "${arg.stage.name}"; re-opened ${preview.reopened.join(", ")}` +
      (refreshed.changed.length > 0
        ? `; reloaded ${refreshed.changed.join(", ")} from harness.json.`
        : "."),
  );

  const next = await vscode.window.showInformationMessage(
    refreshed.changed.length > 0
      ? `Re-opened ${preview.reopened.length} stage(s) and reloaded their instructions.`
      : `Re-opened ${preview.reopened.length} stage(s).`,
    "Advance Route",
  );
  if (next === "Advance Route") {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/**
 * Sends a review stage's findings back to an earlier stage.
 *
 * The gap: a review reported a critical problem and several lesser ones, and the
 * only route back to implementation was "Re-run This Stage" on the *earlier*
 * stage — which discards everything after it, the review's own findings
 * included. So the act of sending work back destroyed the reason for it, and the
 * findings had to be copied out by hand first.
 */
async function sendBackToStageCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof StageTreeItem)) return;
  const task = await rowPipelineTask(ctx, arg, "send this back");
  if (!task) return;

  if (ctx.runner.isRunning(task.id)) {
    void vscode.window.showInformationMessage(
      `"${task.name}" is advancing. Stop the agent first.`,
    );
    return;
  }

  const stage = task.pipeline.stages.find((s) => s.id === arg.stage.id) ?? arg.stage;
  const targets = sendBackTargets(task.pipeline, stage.id);
  if (targets.length === 0) {
    // Named rather than vague: the answer is a line of route config, and without
    // saying which key it is this reads as the feature being broken.
    void vscode.window.showInformationMessage(
      `"${stage.name}" has no stages it may send work back to. Add "sendBackTo": ` +
        `["<stage id>"] to it in harness.json — earlier stages only, so a route cannot loop.`,
    );
    return;
  }

  // A human-verification gate has no agent reply, so it recorded nothing — and it is
  // the one stage where the *operator* is the source of the finding. Refusing here
  // meant the gate that exists for a person to exercise the work was the only place
  // a person could not report what they saw: "Specified cast is not valid" on the
  // report, at DEV sign-off, with no way to send it anywhere.
  let findings = stageFindings(stage);
  if (!findings.trim()) {
    const observed = await vscode.window.showInputBox({
      title: `What went wrong at "${stage.name}"?`,
      prompt: "This becomes the finding the re-opened stage is given.",
      placeHolder:
        'e.g. "Specified cast is not valid" opening the report on DEV, after picking a period',
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? "Say what happened, or press Escape." : undefined,
    });
    if (!observed) return;
    findings = observed.trim();
  }

  // Even with one candidate the choice is shown, because the cost is not obvious
  // from the stage's name: `kind:implementation` can match several stages, and
  // going further back re-opens everything after it. Reaching past the nearest
  // match is sometimes right — a finding can invalidate the plan, not just the
  // code — so the count of discarded stages is on the row rather than the target
  // being decided for the operator.
  const stages = task.pipeline.stages;
  const picked = await vscode.window.showQuickPick(
    targets.map((candidate, index) => {
      const discarded = stages.slice(stages.findIndex((s) => s.id === candidate.id));
      return {
        label: candidate.name,
        description: index === 0 ? `${candidate.id} · nearest` : candidate.id,
        detail:
          `Re-opens ${discarded.length} stage(s), discarding their output: ` +
          discarded.map((s) => s.name).join(" → "),
        stage: candidate,
      };
    }),
    {
      title: `Send findings from "${stage.name}" back to…`,
      placeHolder: "The nearest stage discards the least work",
    },
  );
  const target = picked?.stage;
  if (!target) return;

  const parsed = parseReviewFindings(findings);
  const summary = summariseFindings(parsed) ?? "the stage's report";

  const note = await vscode.window.showInputBox({
    title: `Send back to ${target.name}`,
    prompt: `Anything to add? The findings themselves (${summary}) go with it.`,
    placeHolder: "Optional — e.g. leave the Motability variant alone for now",
  });
  // Escape means "no note", not "cancel": the findings are the payload, and
  // losing the whole action for want of an optional sentence would be worse.

  // Most findings are a thing to fix, not a reason to rebuild — so fixing is the
  // default and rebuilding is the deliberate choice. It used to be the other way
  // round with no way out, which is what made acting on a review cost a whole stage.
  //
  // Offered only when the target has something to correct. A stage that never ran, or
  // one whose output a previous revert already discarded, has nothing for a fix
  // session to start from, so the question would be a false choice.
  const correctable = target.subtasks.some((s) => s.reply || s.activity);
  const how = correctable
    ? await vscode.window.showQuickPick(
        [
          {
            label: "Fix these findings",
            description: "recommended",
            detail:
              `"${target.name}" keeps everything it did and gets one session that changes ` +
              "only what the findings name. Cheaper, and the reviews that passed the rest " +
              "of it stay meaningful.",
            fix: true,
          },
          {
            label: "Re-run the stage from scratch",
            detail:
              `Discards what "${target.name}" produced and does it again with the findings ` +
              "as guidance. For when the approach was wrong, not the code.",
            fix: false,
          },
        ],
        {
          title: `How should "${target.name}" deal with ${summary}?`,
          placeHolder: "Fixing keeps its work; re-running discards it",
        },
      )
    : { fix: false };
  if (!how) return;

  if (how.fix) {
    await applyCorrection(ctx, task, stage, target, {
      findings: parsed.length > 0 ? formatFindings(parsed) : findings.trim(),
      note,
      summary,
    });
    return;
  }

  const preview = sendBackToStage(task.pipeline, {
    targetStageId: target.id,
    fromStageId: stage.id,
    // The parsed form when it parsed, so the stage being redone reads a tidy list
    // rather than a review's prose; verbatim otherwise, because a parser that
    // found nothing must not be allowed to silently drop the findings.
    findings: parsed.length > 0 ? formatFindings(parsed) : findings.trim(),
    note,
    at: new Date().toISOString(),
  });
  if (!preview) return;

  const also = preview.reopened.length - 1;
  const confirmed = await vscode.window.showWarningMessage(
    `Send ${summary} back to "${target.name}"?`,
    {
      modal: true,
      detail:
        `${target.name}${also > 0 ? ` and ${also} later stage(s)` : ""} will be re-opened, ` +
        "and their recorded output discarded — including this review's, which is why " +
        "the findings travel as guidance instead. Every stage from here on is given " +
        "them, and your earlier approval notes are kept.",
    },
    "Send Back",
  );
  if (confirmed !== "Send Back") return;

  // Instructions reloaded from config for the stages that just re-opened, exactly
  // as a revert does — the fix may well be in harness.json too.
  const refreshed = ctx.stageDefinitions
    ? refreshPendingStages(preview.pipeline, ctx.stageDefinitions())
    : { pipeline: preview.pipeline, changed: [] as string[] };

  await ctx.repository.save({
    ...task,
    pipeline: refreshed.pipeline,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(
    `Harness [${task.name}] sent findings from "${stage.name}" back to "${target.name}" ` +
      `(${summary}); re-opened ${preview.reopened.join(", ")}.\n${preview.note}`,
  );

  // Carries straight on, on the same setting as approving. Sending findings back
  // is if anything more deliberate than an approval — a quick-pick, an optional
  // note and a modal confirmation — and its only purpose is to get the earlier
  // stage re-run. Stopping afterwards to ask "shall I continue?" left the task
  // idle behind one more button press, having just been told exactly what to do.
  if (ctx.configuration.advanceAfterAnswering(ctx.repositoryUri())) {
    ctx.logger.info(
      `Harness [${task.name}] advancing automatically after sending findings back.`,
    );
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
    return;
  }

  const next = await vscode.window.showInformationMessage(
    `Sent back to "${target.name}" with ${summary}.`,
    "Advance Route",
  );
  if (next === "Advance Route") {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/** Everything a stage's subtasks reported, which is where findings live. */
function stageFindings(stage: TaskStage): string {
  return stage.subtasks
    .map((subtask) => subtask.reply?.trim())
    .filter((reply): reply is string => !!reply)
    .join("\n\n");
}

async function approveStageCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof StageTreeItem)) return;
  const task = await rowPipelineTask(ctx, arg, "approve this stage");
  if (!task) return;

  // Approval is the one moment a human has just read what a stage produced and
  // knows something the route does not — "deploy only this project", "leave the
  // Motability variant alone". Without somewhere to put it, acting on it meant
  // editing the brief or re-running a stage, so it was either lost or expensive.
  // Blank is the common case and costs one Enter.
  const note = await vscode.window.showInputBox({
    title: `Approve "${arg.stage.name}"`,
    prompt: "Anything the following stages should know? Leave blank to just approve.",
    placeHolder: "e.g. deploy only this ticket's project, with -Project",
    ignoreFocusOut: true,
  });
  // Escape means "I did not mean to approve"; an empty string means "approve, no note".
  if (note === undefined) return;

  const result = approveStage(
    task.pipeline,
    arg.stage.id,
    new Date().toISOString(),
    note,
  );
  if (!result.ok) {
    const choice = await vscode.window.showWarningMessage(
      result.error.message,
      "Show Details",
    );
    if (choice === "Show Details") ctx.logger.show?.();
    return;
  }

  let approved = result.value;

  // Settled here, at the gate of the stage that raised them, rather than only at the
  // deployment door. The hold stays where it is — in front of a stage that ships,
  // for the reason it was put there — but the *settling* was only ever offered at
  // that hold, so a route accumulated declines from 08:40 onwards and presented
  // twelve of them at once, hours later, immediately before a DEV push. Every one of
  // them had passed through a gate where the operator was already standing, had just
  // read the stage's report, and knew the answer.
  //
  // Only this stage's own, and only after the approval has been decided: the
  // question "who owns this?" is answerable because the report explaining it is the
  // thing just read.
  const declined = outstandingDeferrals(approved).filter(
    (item) => item.raisedByStage === arg.stage.id,
  );
  for (const [index, item] of declined.entries()) {
    const resolution = await vscode.window.showInputBox({
      title:
        `"${arg.stage.name}" declined this as belonging elsewhere` +
        (declined.length > 1 ? ` (${index + 1} of ${declined.length})` : ""),
      prompt: askingLine(item.text),
      placeHolder:
        "Who owns this, or why it needs nobody — e.g. the promote stage does it; live-only by design",
      ignoreFocusOut: true,
    });
    // Escape leaves it outstanding rather than abandoning the approval. The approval
    // is already decided by this point, and losing it because someone skipped an
    // optional question would make the gate worse than it was.
    if (resolution === undefined) break;
    if (!resolution.trim()) continue;
    const settled = resolveDeferral(approved, item.id, {
      resolution: resolution.trim(),
      at: new Date().toISOString(),
    });
    if (settled.ok) approved = settled.value;
  }

  await ctx.repository.save({
    ...task,
    pipeline: approved,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  ctx.logger.info(
    `Harness [${task.name}] approved "${arg.stage.name}"` +
      (note?.trim() ? ` with guidance: ${note.trim()}` : "."),
  );

  // Approving is as deliberate as answering a question, and its only purpose is to
  // let the route continue — so it continues, on the same setting.
  if (ctx.configuration.advanceAfterAnswering(ctx.repositoryUri())) {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
    return;
  }

  const next = await vscode.window.showInformationMessage(
    `Approved "${arg.stage.name}".`,
    "Advance Route",
  );
  if (next === "Advance Route") {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/**
 * Ticks every outstanding checklist item on a task in one go.
 *
 * Built for the supervisor case — several tasks in flight, the same handful of boxes
 * on each — but deliberately not frictionless. The human-verification gate's only
 * value is that somebody confirmed each behaviour, so this asks what was done and
 * records that answer against every item it touches. One sentence for N items is
 * still far quicker than N clicks, and it leaves a report that says what actually
 * happened rather than implying N individual verifications.
 *
 * The items are listed in the confirmation rather than counted, because "verify 8
 * items?" is a question nobody can answer and "these 8 behaviours?" is.
 */
async function verifyAllChecklistCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task?.pipeline) return;

  // Scoped to the gate the operator is standing at, when the route has one waiting. A
  // bulk tick that reached across gates would assert somebody exercised a behaviour in
  // an environment the change had not yet reached. Falls back to the whole pipeline when
  // no gate is held — which is also exactly what happens on a route that declares no
  // scopes, since every item resolves to the one gate.
  const gate = task.pipeline.stages.find(
    (stage) => stage.kind === "humanVerification" && stage.status === "awaiting-approval",
  );
  const outstanding = gate
    ? itemsForGate(task.pipeline, gate.id)
    : outstandingChecklist(task.pipeline);
  if (outstanding.length === 0) {
    void vscode.window.showInformationMessage(
      gate
        ? `"${gate.name}" on "${task.name}" has nothing outstanding to verify.`
        : `"${task.name}" has nothing outstanding to verify.`,
    );
    return;
  }

  const shown = outstanding.slice(0, 10).map((item) => `• ${item.text}`);
  if (outstanding.length > shown.length) {
    shown.push(`• …and ${outstanding.length - shown.length} more`);
  }
  const confirm = "Verify All";
  const choice = await vscode.window.showWarningMessage(
    gate
      ? `Mark all ${outstanding.length} item(s) for "${gate.name}" on "${task.name}" as verified?`
      : `Mark all ${outstanding.length} outstanding item(s) on "${task.name}" as verified?`,
    { modal: true, detail: shown.join("\n") },
    confirm,
  );
  if (choice !== confirm) return;

  const note = await vscode.window.showInputBox({
    title: `Verifying ${outstanding.length} item(s) on "${task.name}"`,
    prompt: "What did you do to verify these? Recorded against every item.",
    placeHolder: "e.g. ran the overnight job on dev and checked the scorecard totals",
    ignoreFocusOut: true,
  });
  // Escape cancels the whole thing rather than ticking without a note: the note is the
  // only thing distinguishing this from switching the gate off.
  if (note === undefined) return;
  if (!note.trim()) {
    void vscode.window.showWarningMessage(
      "Nothing was ticked — a note is required, since it is the only record that these were verified at all.",
    );
    return;
  }

  const at = new Date().toISOString();
  const result = checkOutstandingChecklist(task.pipeline, {
    note: note.trim(),
    at,
    ...(gate ? { forGate: gate.id } : {}),
  });
  await ctx.repository.save({ ...task, pipeline: result.pipeline, updatedAt: at });
  ctx.tree.refresh();

  ctx.logger.info(
    `Harness [${task.name}] ${result.checked} checklist item(s) verified in bulk: ${note.trim()}`,
  );
  void vscode.window.showInformationMessage(
    `Verified ${result.checked} item(s) on "${task.name}". Advance the route to pass the gate.`,
  );
}

/**
 * Ticks or un-ticks one verification item.
 *
 * Just the tick. It used to ask what was observed on every check, which put an
 * input box between the tester and the next item on a list that is routinely a
 * dozen long — and the answer was almost always Enter, so the prompt cost more
 * than the notes it collected were worth. Recording an observation is now its own
 * button, for the items where there is actually something to say.
 */
async function toggleChecklistItemCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof ChecklistTreeItem)) return;
  const task = await rowPipelineTask(ctx, arg, "update that checklist item");
  if (!task) return;

  const checking = !arg.item.checked;
  const result = setChecklistItem(task.pipeline, arg.item.id, {
    checked: checking,
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
 * Records what was observed while verifying one item, without changing whether it
 * is ticked.
 *
 * Separate from the tick because the two happen at different rates: everything
 * gets ticked, and only the occasional item has something worth writing down —
 * usually the one that behaved oddly but not wrongly. Asking on every tick made
 * the common case slower to buy the rare one, so it is a button now.
 *
 * Leaving the box empty clears an existing note, which is the only way to correct
 * one that turned out to be wrong.
 */
async function noteChecklistItemCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  if (!(arg instanceof ChecklistTreeItem)) return;
  const task = await rowPipelineTask(ctx, arg, "add that note");
  if (!task) return;

  const note = await vscode.window.showInputBox({
    title: arg.item.text,
    prompt: "What did you observe? This is kept with the item as evidence.",
    placeHolder: "e.g. Verified on staging — dealer id retained",
    // Pre-filled so editing an existing note does not mean retyping it, and so it
    // is obvious the box is not asking for a second, additional note.
    value: arg.item.note ?? "",
    ignoreFocusOut: true,
  });
  // Escape means "leave it as it was"; an empty box means "no note".
  if (note === undefined) return;

  const result = setChecklistItem(task.pipeline, arg.item.id, {
    // Unchanged: this is not a way to tick something, and quietly ticking an item
    // because its note was edited would put evidence against work nobody verified.
    checked: arg.item.checked,
    note,
    at: arg.item.checkedAt ?? new Date().toISOString(),
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
}

/**
 * Drives a harnessed task's route as far as it can go unattended, stopping at the
 * first human gate or failure. Cancellable, because each step spawns an agent
 * session and the whole run can take many minutes.
 */
/**
 * Puts a task's worktree back on the branch the task is about.
 *
 * Exists because the branch guard's message names the git command to run, and being
 * told a command is not the same as being able to run it — the point of the guard is
 * that the route stopped, so the fix belongs where the stop is reported.
 *
 * Plain `git checkout`: no force, no stash. Git refuses when switching would discard
 * local changes, and that refusal is the useful answer rather than an obstacle.
 */
async function checkoutTaskBranchCommand(
  ctx: CommandContext,
  arg: unknown,
  options: { andAdvance?: boolean } = {},
): Promise<void> {
  const taskId =
    typeof arg === "string"
      ? arg
      : arg instanceof TaskWorkspaceTreeItem
        ? arg.task.id
        : arg instanceof StageTreeItem
          ? arg.task.id
          : undefined;
  const task = taskId ? await ctx.repository.get(taskId) : undefined;
  if (!task) return;

  // The recorded intent, not the current branch: the whole question is where the
  // worktree should be, and `branchName` is refreshed from wherever it actually is.
  const target = task.intendedBranch ?? task.branchName;
  if (!target) {
    void vscode.window.showErrorMessage(
      `"${task.name}" has no recorded branch to return to.`,
    );
    return;
  }

  const result = await ctx.worktrees.checkoutBranch(task.worktreePath, target);
  if (!result.ok) {
    // Git's own words: it says precisely which files would be overwritten, which is
    // the information needed to decide what to do about it.
    // git's own words, which name precisely which files would be overwritten — the
    // information needed to decide what to do about it.
    const detail =
      result.error.kind === "git"
        ? result.error.error.stderr?.trim() || result.error.error.message
        : result.error.message;
    void vscode.window.showErrorMessage(
      `Could not check out "${target}" in ${task.worktreePath}: ${detail}`,
    );
    ctx.logger.error(
      `Harness [${task.name}] checkout of "${target}" failed`,
      result.error,
    );
    return;
  }

  ctx.logger.info(`Harness [${task.name}] worktree returned to "${target}".`);
  ctx.tree.refresh();

  if (!options.andAdvance) {
    void vscode.window.showInformationMessage(
      `"${task.name}" is back on "${target}".`,
    );
    return;
  }
  // Advancing straight away, because the user pressed this button on a notification
  // that said the route had stopped: checking out was a means, not the goal.
  await advanceRouteCommand(ctx, task.id);
}

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

  // Reload the instructions of stages that have not started yet. A pipeline is a
  // snapshot, which is right for its *structure* — a route edited mid-flight must
  // not rewrite a task already moving through it — but it also froze each stage's
  // intent, so a wrong instruction could only be fixed by recreating the task.
  // Stages that have already run keep what they ran with, so history stays true.
  let advancing = task;

  // Stages the route gained since this task was created, before the intent refresh so
  // a newly added stage gets the current wording too. The remedy for a route that was
  // missing a step used to be doing it by hand or throwing the task away.
  if (ctx.stageDefinitions && task.pipeline) {
    const grown = addMissingStages(task.pipeline, ctx.stageDefinitions());
    if (grown.added.length > 0) {
      advancing = {
        ...task,
        pipeline: grown.pipeline,
        updatedAt: new Date().toISOString(),
      };
      await ctx.repository.save(advancing);
      ctx.logger.info(
        `Harness [${task.name}] added ${grown.added.join(", ")} from harness.json.`,
      );
    }
    if (grown.tooLate.length > 0) {
      // Said out loud rather than dropped: the route now has a step this task will
      // never run, and the only way to know is to be told.
      ctx.logger.warn(
        `Harness [${task.name}] cannot add ${grown.tooLate.join(", ")} — the route has ` +
          "moved past where they belong. Do those steps by hand, or revert to an " +
          "earlier stage first.",
      );
    }
  }

  // Stages the route *reordered* since this task was created. Done before the rule
  // stages are repositioned, because their placement is computed relative to the route
  // stages around them. A task whose order already matches config sees no change, and a
  // stage that has begun is pinned — so this can only ever repair what is still ahead.
  if (ctx.stageDefinitions && advancing.pipeline) {
    const reordered = repositionRouteStages(advancing.pipeline, ctx.stageDefinitions());
    if (reordered.moved.length > 0) {
      advancing = {
        ...advancing,
        pipeline: reordered.pipeline,
        updatedAt: new Date().toISOString(),
      };
      await ctx.repository.save(advancing);
      ctx.tree.refresh();
      ctx.logger.info(
        `Harness [${advancing.name}] moved ${reordered.moved.join(", ")} into the order ` +
          "harness.json now declares. Stages that have already run were left where they ran.",
      );
    }
  }

  if (ctx.stageDefinitions && advancing.pipeline) {
    const refreshed = refreshPendingStages(advancing.pipeline, ctx.stageDefinitions());
    if (refreshed.changed.length > 0) {
      advancing = {
        ...advancing,
        pipeline: refreshed.pipeline,
        updatedAt: new Date().toISOString(),
      };
      await ctx.repository.save(advancing);
      ctx.logger.info(
        `Harness [${task.name}] reloaded ${refreshed.changed.join(", ")} from harness.json.`,
      );
    }
  }

  // Brings handoff flags in line with config and backfills the conclusions of
  // stages that already ran. Without this the answer to "will my task benefit"
  // would be "recreate it", which throws away everything already approved.
  if (ctx.stageDefinitions && advancing.pipeline) {
    const synced = syncHandoffs(
      advancing.pipeline,
      ctx.stageDefinitions(),
      new Date().toISOString(),
    );
    if (synced.enabled.length > 0 || synced.backfilled.length > 0) {
      advancing = {
        ...advancing,
        pipeline: synced.pipeline,
        updatedAt: new Date().toISOString(),
      };
      await ctx.repository.save(advancing);
      ctx.logger.info(
        `Harness [${advancing.name}] handoffs: ` +
          (synced.enabled.length > 0 ? `enabled on ${synced.enabled.join(", ")}` : "") +
          (synced.enabled.length > 0 && synced.backfilled.length > 0 ? "; " : "") +
          (synced.backfilled.length > 0
            ? `carried forward what ${synced.backfilled.join(", ")} already concluded`
            : "") +
          ".",
      );
    }
  }

  // Repairs a task whose reviews were spliced after a deployment by an earlier
  // build. Done here rather than as a stored-state migration because it depends on
  // stage *kinds*, which only became distinct recently — a task created before that
  // has no deployment stage to get in front of, and repairs itself once its route
  // is reloaded. Only stages that have not run move.
  if (advancing.pipeline) {
    const ordered = repositionRuleStages(advancing.pipeline, ruleInsertionIndex);
    if (ordered.moved.length > 0) {
      advancing = {
        ...advancing,
        pipeline: ordered.pipeline,
        updatedAt: new Date().toISOString(),
      };
      await ctx.repository.save(advancing);
      ctx.tree.refresh();
      ctx.logger.info(
        `Harness [${advancing.name}] moved ${ordered.moved.join(", ")} ahead of the ` +
          "first deployment or gate, so they run before anything is shipped.",
      );
    }
  }

  // Status-bar progress, not a notification. A route runs for many minutes and
  // several can run at once; one dismissable toast per task would bury the ones
  // that actually need an answer. The sidebar already shows which stage and
  // subtask each task is on, and Stop Agent is the cancel affordance — so only
  // outcomes that need a human get a notification, below.
  const report = await withStatus(`Advancing "${task.name}"`, (step) => {
    step("asking the engine what is next");
    return ctx.runner.advance(advancing);
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
      // Offered here because this is the moment a task's extra worktrees stop being
      // needed. Nine of them accumulated over one week of routes, two holding a commit
      // that had never reached DEV — the directories were the visible symptom, the
      // stranded commits the actual loss.
      await offerWorktreeCleanupCommand(ctx, task.id);
      return;
    case "needsInput":
      // The questions are already persisted on the pipeline by the runner, so
      // this only opens the panel. Closing it loses nothing — the task shows an
      // "Answer Questions" action until they are answered.
      ctx.tree.refresh();
      await openQuestionsCommand(ctx, task.id);
      return;
    case "awaitingApproval": {
      // The gate used to say only that a stage was waiting, so a review that blocked
      // and one that passed cleanly arrived looking identical and deciding meant
      // reading the whole reply to find out which. It now states what was found and
      // offers the action it recommends first.
      const latest = await ctx.repository.get(task.id);
      const held = latest?.pipeline?.stages.find((s) => s.id === outcome.stageId);
      if (!latest?.pipeline || !held) {
        void vscode.window.showInformationMessage(
          `"${task.name}" is waiting for you at "${outcome.stageName}".`,
        );
        return;
      }
      const advice = approvalAdvice(latest.pipeline, held);
      // The tree item is what the stage commands take, so the buttons reach exactly
      // the same code paths as the rows — including their guards.
      const row = new StageTreeItem(latest, held);

      // "Send Findings Back…" keeps its ellipsis: the command deliberately asks which
      // stage even when only one matches, because reaching further back discards
      // everything after it and that cost is not visible in a stage's name.
      const buttons =
        advice.action === "sendBack"
          ? ["Send Findings Back…", "Approve", "Show What It Did"]
          : advice.action === "verify"
            ? ["Show What It Did"]
            : ["Approve", "Show What It Did"];

      const choice = await vscode.window.showInformationMessage(
        `"${task.name}" is waiting at "${outcome.stageName}" — ` +
          // Four words, because a notification truncates and the detail belongs in
          // the report. What it has to carry is that approving here ratifies the
          // agent's own account rather than a check.
          (advice.evidence.selfReported ? "⚠ self-reported. " : "") +
          `${advice.headline} ${advice.suggestion}`,
        ...buttons,
      );
      if (choice === "Show What It Did") await showStageReportCommand(ctx, row);
      else if (choice === "Approve") await approveStageCommand(ctx, row);
      else if (choice === "Send Findings Back…") await sendBackToStageCommand(ctx, row);
      return;
    }
    case "blocked": {
      // A block whose cause is a fixable one gets the fix as a button. Being told
      // the git command to run is not the same as being able to run it, and this
      // particular block has exactly one sensible remedy.
      const mismatch = outcome.branchMismatch;
      const choice = await vscode.window.showWarningMessage(
        `"${task.name}" stopped at "${outcome.stageName}"` +
          (outcome.reason ? `: ${outcome.reason}` : "."),
        ...(mismatch ? [`Check Out "${mismatch.intended}"`] : []),
        "Show Details",
      );
      if (choice === "Show Details") ctx.logger.show?.();
      else if (mismatch && choice?.startsWith("Check Out")) {
        await checkoutTaskBranchCommand(ctx, task.id, { andAdvance: true });
      }
      return;
    }
    case "deferredWork": {
      // A warning, not an error. Every stage behaved correctly; what is missing is
      // a decision only a person can make, and the one thing that must not happen
      // is the route shipping while it is unmade.
      const choice = await vscode.window.showWarningMessage(
        `"${task.name}" is holding before "${outcome.stageName}": ` +
          `${outcome.items.length} item(s) every stage declined and nobody picked up.`,
        { modal: false },
        "Settle Them…",
        "Show Details",
      );
      if (choice === "Show Details") ctx.logger.show?.();
      else if (choice === "Settle Them…") await settleDeferralsCommand(ctx, task.id);
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
 * Says the route finished, and offers to tidy away the worktrees it created.
 *
 * Asked rather than done. `planCleanup` is deliberately conservative — created by this
 * task, clean including untracked files, nothing unmerged — but conservative is not the
 * same as agreed, and a worktree is where uncommitted work lives. Branches are never
 * touched either way: a worktree is a checkout that can be remade, while a branch may
 * hold the only copy of its commits.
 *
 * What is retained is said out loud, with its reason. A silent skip reads as "there was
 * nothing to do", and the interesting case here is the opposite: a tree kept back
 * *because* it holds commits nobody has merged.
 */
async function offerWorktreeCleanupCommand(
  ctx: CommandContext,
  taskId: string,
): Promise<void> {
  const task = await ctx.repository.get(taskId);
  const claims = ctx.worktreeClaims;
  if (!task || !claims || (task.worktreeClaims ?? []).length === 0) {
    if (task) {
      void vscode.window.showInformationMessage(`"${task.name}" completed its route.`);
    }
    return;
  }

  const plan = await claims.planFor(task);
  for (const kept of plan.retain) {
    ctx.logger.info(
      `Harness [${task.name}] keeping "${kept.claim.path}": ${kept.reason}.`,
    );
  }

  if (plan.remove.length === 0) {
    void vscode.window.showInformationMessage(
      `"${task.name}" completed its route.` +
        (plan.retain.length > 0
          ? ` ${plan.retain.length} worktree(s) left in place — the log says why.`
          : ""),
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `"${task.name}" completed its route. It created ${plan.remove.length} worktree(s) ` +
      `that are clean and fully merged: ${plan.remove.map((c) => c.path).join(", ")}.`,
    "Remove Them",
    "Leave Them",
  );
  if (choice !== "Remove Them") return;

  const applied = await claims.apply(task, plan, new Date().toISOString());
  ctx.tree.refresh();
  if (applied.failed.length > 0) {
    void vscode.window.showWarningMessage(
      `Removed ${applied.removed.length}; ${applied.failed.length} refused — ` +
        applied.failed.map((f) => `${f.path}: ${f.reason}`).join("; "),
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `Removed ${applied.removed.length} worktree(s). Their branches were left alone.`,
  );
}

/**
 * The label for a settlement box: one line, and a pointer to the rest when there is
 * more. A single-line input with a paragraph attached is the operator reading an
 * argument to answer a question they usually already know the answer to.
 */
function askingLine(text: string): string {
  return isAbridged(text)
    ? `${deferralHeadline(text)}  —  full text in the stage report`
    : deferralHeadline(text);
}

/**
 * Works through the items every stage declined, one at a time.
 *
 * Each needs a sentence, not a tick. The reason a live publish halted on a
 * missing structure was that nobody had ever written down who owns it — so
 * settling an item with silence would reproduce exactly the gap this exists to
 * close. The sentence is kept on the item and offered as route guidance, which is
 * what carries it to the stages that still have to act.
 */
async function settleDeferralsCommand(
  ctx: CommandContext,
  taskId: string | undefined,
): Promise<void> {
  let task = taskId ? await ctx.repository.get(taskId) : undefined;
  if (!task?.pipeline) return;

  const pipeline = task.pipeline;
  const items = outstandingDeferrals(pipeline);
  for (const [index, item] of items.entries()) {
    const resolution = await vscode.window.showInputBox({
      title:
        `Declined by "${item.raisedByStageName}"` +
        (items.length > 1 ? ` (${index + 1} of ${items.length})` : ""),
      prompt: askingLine(item.text),
      placeHolder:
        "Who owns this, or why it needs nobody — e.g. live-only by design; the publish stage creates it",
      ignoreFocusOut: true,
    });
    // Escape stops the whole run rather than skipping to the next item: the
    // remaining ones are still outstanding, and silently moving past one would
    // look like it had been settled.
    if (resolution === undefined) break;
    if (!resolution.trim()) {
      void vscode.window.showWarningMessage(
        "A reason is required — it is the thing that was missing when every stage declined this.",
      );
      break;
    }

    const settled = resolveDeferral(task.pipeline ?? pipeline, item.id, {
      resolution,
      at: new Date().toISOString(),
    });
    if (!settled.ok) {
      void vscode.window.showErrorMessage(settled.error.message);
      return;
    }
    task = { ...task, pipeline: settled.value, updatedAt: new Date().toISOString() };
    await ctx.repository.save(task);
    ctx.logger.info(
      `Harness [${task.name}] settled a deferred item from "${item.raisedByStageName}": ` +
        `${item.text} → ${resolution.trim()}`,
    );
  }

  ctx.tree.refresh();
  const left = outstandingDeferrals(task.pipeline ?? pipeline).length;
  if (left > 0) {
    void vscode.window.showInformationMessage(
      `${left} item(s) still outstanding — the route holds until each has an owner.`,
    );
    return;
  }
  if (ctx.configuration.advanceAfterAnswering(ctx.repositoryUri())) {
    await vscode.commands.executeCommand("taskWorkspaces.advanceRoute", task.id);
  }
}

/** The task a command was invoked on, whether from a row or by id. */
function taskIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof TaskWorkspaceTreeItem) return arg.task.id;
  if (arg instanceof StageTreeItem) return arg.task.id;
  return undefined;
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
    // passed explicitly or none of its servers start — reduced to the named
    // servers, exactly as a stage session is. A person waiting on a chat pays the
    // same connect timeouts a subtask does, and notices them more.
    mcpConfigPath: ctx.reducedMcpConfigPath(task.repositoryRoot),
    // Without strict mode the worktree's own approved config starts everything
    // anyway and the reduction achieves nothing. Only when the set was narrowed on
    // purpose, because strict mode also drops the user's own user-scope servers.
    strictMcpConfig: ctx.mcpNarrowed(),
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
/**
 * The task a command was invoked on, from a tree item or a bare id.
 *
 * Exported because every task command must accept the same argument shapes. A second
 * copy in another module would silently miss the next shape added here, and the
 * failure is invisible: an unresolved task means the command returns having done
 * nothing, which several of them do legitimately.
 */
/**
 * A tree row's task, reloaded from the repository, with its pipeline.
 *
 * Every stage command reloaded the task and returned silently when it had no pipeline.
 * That looked like a defensive nicety and was hiding a real fault: during activation the
 * repository falls through to the Memento — a backup, not the source of truth — so the
 * task was genuinely not there, and right-clicking "Re-run This Stage…" showed
 * "Activating Extensions…" and then nothing at all. Seven commands were dead in that
 * window and none of them said so.
 *
 * The wait is fixed at the source (see the repository resolver in `extension.ts`). This
 * is the second half: the row the user right-clicked is proof the task exists, so
 * failing to load it is a fault to report rather than a condition to ignore.
 */
async function rowPipelineTask(
  ctx: CommandContext,
  row: { task: TaskWorkspace },
  action: string,
  // The narrowing the inline check used to give callers: every one of them reads
  // task.pipeline straight afterwards, so the guarantee has to survive the extraction.
): Promise<(TaskWorkspace & { pipeline: TaskPipeline }) | undefined> {
  const task = await ctx.repository.get(row.task.id);
  if (task?.pipeline) return task as TaskWorkspace & { pipeline: TaskPipeline };
  void vscode.window.showWarningMessage(
    `Could not load "${row.task.name}" to ${action}. ` +
      "If this window has only just opened, try again in a moment.",
  );
  ctx.logger.warn(
    `Could not ${action} for task ${row.task.id}: no task with a pipeline was loaded.`,
  );
  return undefined;
}

export async function resolveTask(
  ctx: CommandContext,
  arg: unknown,
): Promise<TaskWorkspace | undefined> {
  if (typeof arg === "string") return ctx.repository.get(arg);
  // Every row in the tree carries its task — the stage rows, the checklist items,
  // the questions, the refusals, the held calls. Only two of the six were recognised,
  // so a command invoked from any of the others reported "No task selected" while
  // pointing straight at one. Read structurally rather than by class, so a row type
  // added later works without this list being remembered.
  return rowTask(arg);
}

/**
 * The task a command should act on, asking when the invocation carries none.
 *
 * Commands are contributed to the palette as well as to the tree, and from the
 * palette there is no row and therefore no argument. Answering that with "No task
 * selected" is a dead end for a command the user just deliberately chose — so it
 * asks instead.
 */
async function resolveTaskOrAsk(
  ctx: CommandContext,
  arg: unknown,
  title: string,
): Promise<TaskWorkspace | undefined> {
  const direct = await resolveTask(ctx, arg);
  if (direct) return direct;

  const repositoryRoot = ctx.resolveRepositoryRoot();
  const tasks = repositoryRoot
    ? await ctx.repository.getByRepository(repositoryRoot)
    : [];
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage("There are no tasks in this repository.");
    return undefined;
  }
  if (tasks.length === 1) return tasks[0];

  const picked = await vscode.window.showQuickPick(
    tasks.map((task) => ({
      label: task.name,
      description: task.branchName,
      detail: task.pipeline?.routeLabel ?? task.pipeline?.routeId,
      task,
    })),
    { title, placeHolder: "Which task?" },
  );
  return picked?.task;
}

async function openCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  const uri = vscode.Uri.file(task.worktreePath);
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceNewWindow: true,
  });
}

/**
 * Whether this VS Code build has the multi-file diff editor.
 *
 * Probed rather than assumed: `vscode.changes` is a built-in command, not part of
 * the extension API, so it carries no version guarantee — and calling a missing
 * command surfaces as a raw error dialog.
 */
let multiDiffSupported: boolean | undefined;
async function multiDiffAvailable(): Promise<boolean> {
  if (multiDiffSupported === undefined) {
    multiDiffSupported = (await vscode.commands.getCommands(true)).includes("vscode.changes");
  }
  return multiDiffSupported;
}

/** Git reports forward-slashed relative paths; the editor needs a real one. */
function joinWorktreePath(worktreePath: string, relative: string): string {
  return path.join(worktreePath, ...relative.split("/"));
}

/**
 * Shows a task's changes as a file list with each file's own before/after
 * comparison — the shape a code review actually has.
 *
 * Falls back to the unified patch when the multi-file editor is unavailable or
 * when git cannot resolve the branch point, because a reviewer with a plain
 * patch is better served than one with an error.
 */
async function showDiffCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;

  const listed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Listing changes…" },
    async () => {
      const files = await ctx.status.getChangedFiles(task.worktreePath, task.baseBranch);
      if (!files.ok) return files;
      const mergeBase = await ctx.status.getMergeBase(task.worktreePath, task.baseBranch);
      return mergeBase.ok ? ok({ files: files.value, mergeBase: mergeBase.value }) : mergeBase;
    },
  );

  if (listed.ok && listed.value.files.length === 0) {
    void vscode.window.showInformationMessage(
      `${task.name} has no changes relative to ${task.baseBranch}.`,
    );
    return;
  }

  if (listed.ok && (await multiDiffAvailable())) {
    const rows = changeRows(listed.value.files, listed.value.mergeBase);
    const resources = rows.map((row) => {
      const side = (which: "before" | "after"): vscode.Uri => {
        const source = row[which];
        if (source.kind === "empty") return ctx.blobProvider.emptyUriFor(row.path);
        if (source.kind === "worktree") {
          return vscode.Uri.file(joinWorktreePath(task.worktreePath, source.path));
        }
        return ctx.blobProvider.uriFor(task.worktreePath, source.revision, source.path);
      };
      // The first URI is the row's identity, so it is the real file: that is what
      // gives each row its file icon, its folder subtitle and a working "open".
      return [
        vscode.Uri.file(joinWorktreePath(task.worktreePath, row.path)),
        side("before"),
        side("after"),
      ];
    });

    try {
      await vscode.commands.executeCommand(
        "vscode.changes",
        `${task.name} · ${changeSummary(listed.value.files)}`,
        resources,
      );
      return;
    } catch (error) {
      ctx.logger.warn(`Multi-file diff failed, falling back to a patch: ${String(error)}`);
    }
  }

  if (!listed.ok) {
    ctx.logger.warn(`Could not list changed files: ${listed.error.message}`);
  }

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

  // Planned before the prompt so the dialog can say what else goes. A route's stages
  // create worktrees the user never asked for by name — a promote/* tree per
  // environment — and removing the task without them left the directories behind with
  // nothing left pointing at them. The plan stays conservative here exactly as it is at
  // route completion: agreeing to remove a task is not agreeing to discard uncommitted
  // work in a tree you may not know exists.
  const claimPlan =
    ctx.worktreeClaims && (task.worktreeClaims ?? []).length > 0
      ? await ctx.worktreeClaims.planFor(task)
      : undefined;
  const alsoRemoving = claimPlan?.remove.length ?? 0;
  const alsoKeeping = claimPlan?.retain.length ?? 0;
  const claimDetail = [
    alsoRemoving > 0
      ? `Also removing ${alsoRemoving} worktree(s) this task created.`
      : "",
    alsoKeeping > 0
      ? `Keeping ${alsoKeeping}: ${claimPlan!.retain.map((r) => r.reason).join("; ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const detail = [`Branch: ${task.branchName}`, claimDetail].filter(Boolean).join("\n");

  // Offer branch deletion as an extra choice in the confirmation box.
  const choice = live.isDirty
    ? await vscode.window.showWarningMessage(
        `"${task.name}" has ${live.changedFileCount} uncommitted change(s). Removing the worktree will discard them.`,
        { modal: true, detail },
        keepBranch,
        withBranch,
      )
    : await vscode.window.showWarningMessage(
        `Remove worktree for "${task.name}"?`,
        { modal: true, detail },
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

    // Before the task's own worktree, because `apply` re-reads the task to drop the
    // claims it cleared — and once `removeTask` has run there is no task to re-read,
    // so the claims would be dropped into nothing while the directories stayed.
    if (claimPlan && claimPlan.remove.length > 0 && ctx.worktreeClaims) {
      step(`removing ${claimPlan.remove.length} worktree(s) this task created`);
      const outcome = await ctx.worktreeClaims.apply(
        task,
        claimPlan,
        new Date().toISOString(),
      );
      for (const failure of outcome.failed) {
        ctx.logger.warn(
          `Could not remove "${failure.path}" while removing "${task.name}": ${failure.reason}`,
        );
      }
    }

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
  const driving = ctx.runner.isRunning(task.id);
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

  // Everything above this line is in-memory: `cancel` is a lookup in a map of live
  // advances, `stop` a lookup in a map of live sessions, and the only write is
  // guarded by `task.agent`, which a *stage* session does not have. So a stop
  // ordered on a task whose owning host has died did all of nothing and then
  // refreshed an unchanged tree — which is exactly what it looked like, and left
  // the subtask `active` forever with no other way back from that state.
  //
  // Only when no advance is running: a live one reverts the subtask itself as it
  // unwinds, and racing it here would write over the driver's own account.
  let reclaimed: readonly { subtaskTitle: string }[] = [];
  if (!driving) {
    // Re-read, because a stop can be ordered long after the tree row was built and
    // the pipeline is the thing being edited.
    const current = (await ctx.repository.get(task.id)) ?? task;
    const outcome = await ctx.runner.reclaimStale(current, new Date().toISOString());
    reclaimed = outcome.reclaimed;
  }

  ctx.tree.refresh();

  // Said out loud in every case. A stop that reports nothing is indistinguishable
  // from a stop that failed, which is how several were ordered in a row against a
  // task nothing was going to change.
  if (reclaimed.length > 0) {
    void vscode.window.showInformationMessage(
      `Stopped "${task.name}". ${reclaimed
        .map((item) => `"${item.subtaskTitle}"`)
        .join(", ")} had been left running by a session that is gone; ` +
        "back to pending, so Advance Route re-runs it.",
    );
  } else if (driving) {
    void vscode.window.showInformationMessage(`Stopping the route for "${task.name}".`);
  } else {
    void vscode.window.showInformationMessage(
      `Nothing was running for "${task.name}".`,
    );
  }
}

function describeWorktreeError(error: unknown): string {
  const e = error as { kind?: string; message?: string; error?: { message?: string } };
  if (e?.kind === "dirty" && e.message) return e.message;
  if (e?.kind === "unmerged" && e.message) return e.message;
  if (e?.kind === "validation" && e.message) return e.message;
  if (e?.error?.message) return `Git error: ${e.error.message}`;
  return "Failed to remove task workspace.";
}

/**
 * Puts an existing task on a route.
 *
 * The gap this closes: `createPipeline` was reachable from exactly one place — task
 * creation — so work already under way could never enter the runtime. The fallback was
 * a chat session, outside every gate the harness provides, which is precisely the work
 * that most needs them.
 *
 * The offer to assess is the honest half. Attaching a route to half-finished work and
 * running from stage one redoes what is done; letting the operator tick off the stages
 * they believe are complete records work as done because somebody said so, with no
 * evidence and nothing to read later — the exact failure this harness exists to
 * prevent. An assessment stage turns that claim into an artefact, and its gate is where
 * a person approves it.
 */
async function attachRouteCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = await resolveTask(ctx, arg);
  if (!task) return;
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) return;

  // Refused rather than merged. A pipeline holds what has already happened —
  // approvals, checklist items, deferrals, handoffs — and replacing it would discard
  // that silently. Re-opening a stage is the supported way back.
  if (task.pipeline) {
    void vscode.window.showWarningMessage(
      `"${task.name}" is already on the ${task.pipeline.routeLabel ?? task.pipeline.routeId} route.`,
      { modal: true, detail: "Remove and recreate the task to change its route." },
    );
    return;
  }

  const scope = ctx.repositoryUri?.();
  const harness = loadHarness(repositoryRoot, {
    configuredPath: ctx.configuration.harnessConfigPath(scope),
  });
  const picked = await vscode.window.showQuickPick(
    harness.routes.map((route: RouteDefinition) => ({
      label: route.label,
      detail: `${route.description} (${route.stages.length} stages)`,
      route,
    })),
    { title: `Attach a route to "${task.name}"`, placeHolder: "Which route should this follow?" },
  );
  if (!picked) return;

  const started = await vscode.window.showQuickPick(
    [
      {
        label: "Yes — assess what is already done first",
        detail:
          "Adds an assessment stage that reads the worktree and reports which stages " +
          "the existing work already satisfies. You approve its findings before any " +
          "stage is skipped.",
        assess: true,
      },
      {
        label: "No — run the route from the beginning",
        detail: "Every stage runs. Stages are told their output may already exist.",
        assess: false,
      },
    ],
    {
      title: "Has work on this task already started?",
      placeHolder: "This decides whether stages can be skipped on evidence.",
    },
  );
  if (!started) return;

  const pipeline = createPipeline(
    started.assess
      ? {
          ...picked.route,
          stages: [assessmentStageDefinition(), ...picked.route.stages],
        }
      : picked.route,
  );

  await ctx.repository.save({
    ...task,
    pipeline,
    updatedAt: new Date().toISOString(),
  });
  ctx.tree.refresh();
  void vscode.window.showInformationMessage(
    `"${task.name}" is now on the ${picked.route.label} route.` +
      (started.assess ? " Advance it to assess what is already done." : ""),
  );
}

/**
 * Makes a task for a branch that already carries work.
 *
 * The remaining way in. `Attach a Route…` needs a task; adoption needs a worktree.
 * Work done before this extension existed, or by a chat-only task, has neither — just
 * a branch — and that is exactly the work with no record of what was done to it.
 *
 * Nothing is rebased, merged or moved. A worktree is checked out for the branch as it
 * stands, because the work on it is the whole reason it matters.
 */
async function adoptBranchCommand(ctx: CommandContext): Promise<void> {
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) {
    void vscode.window.showErrorMessage("No Git repository is open.");
    return;
  }
  const scope = ctx.repositoryUri?.();

  const branches = await ctx.merges.listBranches(repositoryRoot);
  if (!branches.ok) {
    void vscode.window.showErrorMessage("Could not list branches.");
    return;
  }

  // Branches already spoken for are filtered out rather than shown and rejected: a
  // branch checked out elsewhere cannot have a second worktree, and one that is
  // already a task does not need adopting.
  const tasks = await ctx.repository.getByRepository(repositoryRoot);
  const taken = new Set(tasks.map((task) => task.branchName));
  const worktrees = await ctx.worktrees.listWorktrees(repositoryRoot);
  if (worktrees.ok) {
    for (const worktree of worktrees.value) {
      if (worktree.branch) taken.add(worktree.branch);
    }
  }
  const candidates = branches.value.filter((branch) => !taken.has(branch));
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      "Every local branch is already a task or checked out in a worktree.",
    );
    return;
  }

  const branchName = await vscode.window.showQuickPick(candidates, {
    title: "Create Task from Existing Branch",
    placeHolder: "Which branch holds the work?",
  });
  if (!branchName) return;

  const name = await vscode.window.showInputBox({
    title: "Create Task from Existing Branch",
    prompt: "Task name",
    value: branchName.replace(/^.*\//, "").replace(/[-_]+/g, " ").trim(),
    validateInput: (value) =>
      value.trim().length === 0 ? "Task name is required." : undefined,
  });
  if (!name) return;

  // Asked, never guessed. This is what later stages diff against, so a wrong answer
  // makes every review read the wrong set of changes.
  let defaultBase = ctx.configuration.defaultBaseBranch(scope);
  if (!defaultBase) {
    const current = await ctx.worktrees.getCurrentBranch(repositoryRoot);
    defaultBase = current.ok && current.value ? current.value : "HEAD";
  }
  const baseBranch = await vscode.window.showInputBox({
    title: "Create Task from Existing Branch",
    prompt: "Base branch — what this work should be compared against",
    value: defaultBase,
    validateInput: (value) =>
      value.trim().length === 0 ? "Base branch is required." : undefined,
  });
  if (!baseBranch) return;

  const created = await withStatus(`Adopting ${branchName}`, async (step) => {
    step("checking out a worktree for the branch");
    return ctx.service.createTaskFromBranch({
      repositoryRoot,
      name,
      branchName,
      baseBranch: baseBranch.trim(),
      configuredParentDir: ctx.configuration.worktreeParentDir(scope),
    });
  });
  if (!created.ok) {
    void vscode.window.showErrorMessage(
      "message" in created.error
        ? created.error.message
        : "Could not adopt that branch.",
    );
    return;
  }

  // Provisioned exactly as a new task is: a worktree checked out here is as bare of
  // untracked local config as any other, and an agent in it would behave differently
  // from one in the main checkout.
  ctx.provisioner.provision(
    ctx.configuration.copyIntoWorktree(scope),
    repositoryRoot,
    created.value.worktreePath,
  );
  ctx.provisioner.linkSiblings(
    ctx.configuration.linkSiblings(scope),
    repositoryRoot,
    created.value.worktreePath,
  );

  ctx.tree.refresh();
  // Straight into the route picker, since a task adopted from a branch with work on
  // it is precisely the case the assessment stage exists for.
  await attachRouteCommand(ctx, created.value.id);
}
