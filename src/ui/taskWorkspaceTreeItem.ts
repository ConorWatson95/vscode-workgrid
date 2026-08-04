import * as vscode from "vscode";
import { TaskWorkspace, TaskWorkspaceLiveState } from "../domain/taskWorkspace";
import {
  taskStatusPresentation,
  buildContextValue,
  AgentActivity,
} from "./statusPresentation";
import { deriveTaskPhase, taskPhasePresentation } from "./taskPhase";
import {
  ChecklistItem,
  DenialItem,
  QuestionItem,
  TaskStage,
} from "../domain/taskPipeline";
import {
  checklistPresentation,
  pipelineSummary,
  stagePresentation,
  stageExpansion,
  stageBlock,
  blockedStageVisual,
  activeStageLabel,
} from "./stagePresentation";

/** A tree node representing a single task workspace. */
export class TaskWorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly live: TaskWorkspaceLiveState | undefined,
    readonly agentActivity: AgentActivity | undefined,
    /**
     * Tool calls the agent is blocked on right now. Counted here because they
     * decide whether the row can be expanded at all — a held call the user cannot
     * reach is a route stopped with no way to restart it.
     */
    readonly heldCallCount = 0,
  ) {
    // A harnessed task expands to show its route; an unharnessed one has no
    // children, so it stays a leaf exactly as before — unless something is
    // waiting on the user, which is always reachable.
    const hasChildren = (task.pipeline?.stages.length ?? 0) > 0 || heldCallCount > 0;
    super(
      task.name,
      hasChildren
        ? heldCallCount > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = task.id;

    let iconId: string;
    let colorId: string | undefined;
    let statusLabel: string;

    // Terminal task states (archived/failed/creating) win; otherwise the icon
    // reflects the derived lifecycle phase (git state + agent activity).
    if (task.status === "archived" || task.status === "failed" || task.status === "creating") {
      const p = taskStatusPresentation(task.status);
      iconId = p.iconId;
      statusLabel = p.label;
    } else {
      const phase = deriveTaskPhase({
        activity: agentActivity,
        dirty: live?.isDirty ?? false,
        commitsAhead: live?.commitsAhead ?? 0,
      });
      const p = taskPhasePresentation(phase);
      iconId = p.iconId;
      colorId = p.colorId;
      statusLabel = p.label;

      // A harnessed task's route knows better than the git heuristics do. The
      // phase is derived from dirty files and commits, so a task whose planning
      // stage was still running reported "implementing" — technically a
      // reasonable guess about the worktree, and wrong about the work.
      const stageLabel = activeStageLabel(task.pipeline);
      if (stageLabel) statusLabel = stageLabel;
    }

    this.iconPath = new vscode.ThemeIcon(
      iconId,
      colorId ? new vscode.ThemeColor(colorId) : undefined,
    );
    const harnessed = (task.pipeline?.stages.length ?? 0) > 0;
    const questions = task.pipeline?.pendingQuestion?.items.length ?? 0;
    const denied = (task.pipeline?.pendingDenials?.items ?? []).filter(
      (i) => !i.granted,
    ).length;
    this.contextValue = buildContextValue(
      task.status,
      task.agent?.status,
      harnessed,
      questions > 0,
      denied > 0,
    );

    const descriptionParts = [statusLabel];
    // Lead with the block: a route waiting on an answer is doing nothing, and
    // that is invisible otherwise.
    if (heldCallCount > 0) {
      descriptionParts.unshift(
        heldCallCount === 1
          ? "paused — 1 call waiting"
          : `paused — ${heldCallCount} calls waiting`,
      );
    }
    if (questions > 0) {
      descriptionParts.unshift(
        questions === 1 ? "1 question" : `${questions} questions`,
      );
    }
    if (denied > 0) {
      descriptionParts.unshift(
        denied === 1 ? "1 to approve" : `${denied} to approve`,
      );
    }
    if (live?.isDirty) {
      descriptionParts.push(`${live.changedFileCount} changed`);
    } else if ((live?.commitsAhead ?? 0) > 0) {
      descriptionParts.push(`${live!.commitsAhead} commit${live!.commitsAhead === 1 ? "" : "s"}`);
    }
    this.description = descriptionParts.join(" · ");

    // The pipeline records its own route label, so a project route that has since
    // been renamed or removed still renders correctly.
    const summary = pipelineSummary(task.pipeline, task.pipeline?.routeLabel);

    this.tooltip = new vscode.MarkdownString(
      [
        `**${task.name}**`,
        "",
        `Status: ${statusLabel}`,
        summary ? `Route: ${summary}` : "",
        // Shown because it is handed to every stage prompt — if it is wrong or
        // empty, every agent session inherits that.
        task.description ? `\nBrief: ${task.description}` : "",
        `Branch: \`${task.branchName}\``,
        `Base: \`${task.baseBranch}\``,
        `Worktree: \`${task.worktreePath}\``,
        live && !live.worktreeExists ? "\n⚠️ Worktree missing" : "",
        live?.isDirty ? `\nChanged files: ${live.changedFileCount}` : "",
        task.agent ? `\nAgent: ${task.agent.provider} (${task.agent.status})` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    // Default click opens the task detail view.
    this.command = {
      command: "taskWorkspaces.detail",
      title: "Open Task Details",
      arguments: [this],
    };
  }
}

/**
 * A pipeline stage nested under its task. Read-only progress: stages are driven
 * by the engine, not edited here.
 */
export class StageTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly stage: TaskStage,
  ) {
    // Everything that nests under a stage is counted by `stageExpansion`, which
    // is where the rule is tested — a stage whose only children were refusals,
    // and later one whose only children were questions, each counted zero and
    // became a leaf, putting the rows that resolve them out of reach.
    const { childCount, needsAttention } = stageExpansion(task.pipeline, stage);
    super(
      stage.name,
      childCount > 0
        ? needsAttention
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    // A stage waiting on the user is shown as waiting, not as working: the
    // spinner was identical whether it was running or sitting on seven
    // unanswered questions. `contextValue` is untouched, because it drives the
    // menu actions that resolve the block.
    const base = stagePresentation(stage);
    const block = stageBlock(task.pipeline, stage);
    const visual = block ? { ...base, ...blockedStageVisual(block) } : base;

    this.id = `${task.id}/${stage.id}`;
    this.iconPath = new vscode.ThemeIcon(
      visual.iconId,
      visual.colorId ? new vscode.ThemeColor(visual.colorId) : undefined,
    );
    this.description = visual.description;
    this.contextValue = base.contextValue;

    this.tooltip = new vscode.MarkdownString(
      [
        `**${stage.name}** — ${visual.label}`,
        "",
        stage.intent,
        stage.addedByRule ? `\n_Added by a review rule: ${stage.addedByRule}_` : "",
        stage.subtasks.length > 0
          ? `\nSubtasks:\n${stage.subtasks
              .map((s) => `- ${s.title} (${s.status})`)
              .join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/** One verification item, nested under the stage that raised it. */
export class ChecklistTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly stageId: string,
    readonly item: ChecklistItem,
  ) {
    super(item.text, vscode.TreeItemCollapsibleState.None);
    const visual = checklistPresentation(item);
    this.id = `${task.id}/${stageId}/${item.id}`;
    this.iconPath = new vscode.ThemeIcon(
      visual.iconId,
      visual.colorId ? new vscode.ThemeColor(visual.colorId) : undefined,
    );
    this.contextValue = visual.contextValue;
    this.description = item.checked ? "verified" : "";
    this.tooltip = new vscode.MarkdownString(
      [
        item.text,
        "",
        item.checked ? `Verified${item.checkedAt ? ` at ${item.checkedAt}` : ""}.` : "Not yet verified.",
        item.note ? `\nNote: ${item.note}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/**
 * A tool call the permission layer refused, with an approve action on the row.
 *
 * A row rather than a panel or a toast: a toast is transient and stacks across
 * tasks, and this needs one button, not a window. It sits under the stage that
 * hit it and stays until granted, so it is still there after a reload.
 */
/**
 * One question a stage asked, nested under that stage.
 *
 * Questions used to be reported only as "7 questions" on the task row, with the
 * way to answer them behind an inline action VS Code reveals on hover — so the
 * count was plainly visible and the means to act on it was not. Refusals learned
 * this lesson in 0.19.1; this is the same shape, for the same reason.
 *
 * Clicking the row opens the panel. The row that names a question should be the
 * thing that answers it.
 */
export class QuestionTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly question: QuestionItem,
  ) {
    super(question.text, vscode.TreeItemCollapsibleState.None);
    this.id = `${task.id}/question/${question.id}`;

    const answered = (question.answer ?? "").trim().length > 0;
    this.iconPath = new vscode.ThemeIcon(
      answered ? "pass" : "comment-discussion",
      new vscode.ThemeColor(
        answered ? "testing.iconPassed" : "notificationsWarningIcon.foreground",
      ),
    );
    this.contextValue = answered ? "questionAnswered" : "questionPending";
    this.description = answered ? "answered" : "awaiting an answer";
    this.tooltip = new vscode.MarkdownString(
      [
        answered ? "**Answered**" : "**Waiting for an answer**",
        "",
        question.text,
        answered ? `\n---\n${question.answer}` : "",
        "\n_Click to open the answer panel._",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    this.command = {
      command: "taskWorkspaces.answerQuestions",
      title: "Answer Questions",
      // The task id, not the item: the panel shows every question at once, and
      // `resolveTask` accepts an id.
      arguments: [task.id],
    };
  }
}

export class DenialTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly denial: DenialItem,
  ) {
    super(denial.command ?? denial.tool, vscode.TreeItemCollapsibleState.None);
    this.id = `${task.id}/denial/${denial.id}`;
    this.iconPath = new vscode.ThemeIcon(
      denial.granted ? "pass" : "shield",
      new vscode.ThemeColor(
        denial.granted ? "testing.iconPassed" : "notificationsWarningIcon.foreground",
      ),
    );
    // Only an ungranted refusal offers the approve action.
    this.contextValue = denial.granted ? "denialGranted" : "denialPending";
    this.description = denial.granted
      ? "allowed"
      : `${denial.tool} denied${denial.attempts > 1 ? ` · ${denial.attempts} attempts` : ""}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${denial.tool} was denied**`,
        "",
        denial.command ? "```\n" + denial.command + "\n```" : "",
        denial.reason,
        "",
        denial.rule
          ? denial.granted
            ? `Rule added: \`${denial.rule}\``
            : `Approving adds \`${denial.rule}\` to \`.claude/settings.local.json\`.`
          : "No rule could be derived from this call; grant it by hand.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/**
 * A tool call the agent is **currently blocked on**, waiting for a decision.
 *
 * Distinct from `DenialTreeItem`, which reports a refusal after the fact. This
 * one is live: the CLI is paused on it, and approving lets the agent carry on
 * mid-turn. Rendered urgently for that reason — the route is doing nothing at all
 * until it is answered.
 */
export class HeldCallTreeItem extends vscode.TreeItem {
  constructor(
    readonly task: TaskWorkspace,
    readonly held: {
      request: { id: string; toolName: string };
      detail: string;
      waitingSince: string;
    },
    /** The rule "Always allow" would add, when one can be derived. */
    readonly rule: string | undefined,
  ) {
    super(held.detail, vscode.TreeItemCollapsibleState.None);
    this.id = `${task.id}/held/${held.request.id}`;
    this.iconPath = new vscode.ThemeIcon(
      "debug-pause",
      new vscode.ThemeColor("notificationsWarningIcon.foreground"),
    );
    this.contextValue = rule ? "heldCallWithRule" : "heldCall";
    this.description = `${held.request.toolName} · waiting ${formatWaited(held.waitingSince)}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${held.request.toolName} is waiting for you**`,
        "",
        "```",
        held.detail,
        "```",
        `The agent is paused on this call — the route will not progress until you decide.`,
        "",
        rule
          ? `"Always allow" also adds \`${rule}\` to \`.claude/settings.local.json\`.`
          : "No rule can be derived from this call, so it can only be approved for now or for this session.",
      ].join("\n"),
    );
    // Clicking is the common case, so make it the safe one: show the choices
    // rather than granting anything.
    this.command = {
      command: "taskWorkspaces.decideHeldCall",
      title: "Decide",
      arguments: [this],
    };
  }
}

/** Rough, and deliberately so: the point is "a while", not a stopwatch. */
function formatWaited(since: string): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return "…";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A node representing an untracked git worktree that can be adopted. */
export class OrphanWorktreeTreeItem extends vscode.TreeItem {
  constructor(
    readonly worktreePath: string,
    readonly branch: string | undefined,
  ) {
    super(branch ?? worktreePath, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("git-branch");
    this.description = "untracked";
    this.contextValue = "orphan";
    this.tooltip = new vscode.MarkdownString(
      [
        "**Untracked worktree**",
        "",
        branch ? `Branch: \`${branch}\`` : "(detached)",
        `Path: \`${worktreePath}\``,
        "",
        "Adopt it to track it as a task, or remove it without tracking it.",
      ].join("\n"),
    );
    this.command = {
      command: "taskWorkspaces.adopt",
      title: "Adopt Worktree",
      arguments: [this],
    };
  }
}

/** A simple message node (e.g. "no repository", "no tasks yet"). */
export class MessageTreeItem extends vscode.TreeItem {
  constructor(message: string, iconId = "info") {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = "message";
  }
}
