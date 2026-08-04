import { Subtask, SubtaskActivity, TaskStage, TaskPipeline } from "../domain/taskPipeline";

/**
 * Renders what a stage did, as markdown, for a read-only document.
 *
 * Exists because a stage session is otherwise invisible: it runs headless and its
 * reply was parsed and discarded, so a preview that produced pages of output left
 * nothing to look at and had to be re-run by hand to be seen.
 *
 * Pure and vscode-free, so the layout is testable — which matters because the
 * failure mode of a report is being subtly wrong about what happened.
 */

/** One stage's report. */
export function formatStageReport(
  taskName: string,
  stage: TaskStage,
  pipeline: TaskPipeline | undefined,
): string {
  const lines: string[] = [
    `# ${stage.name}`,
    "",
    `**Task:** ${taskName}  `,
    `**Stage:** \`${stage.id}\` · ${stage.kind} · ${stage.status}`,
  ];
  if (stage.model) lines.push(`**Model:** ${stage.model}  `);
  if (stage.addedByRule) lines.push(`**Added by rule:** ${stage.addedByRule}  `);
  lines.push("", "## Intent", "", stage.intent);

  const guidance = (pipeline?.guidance ?? []).filter(
    (note) => note.stageId === stage.id,
  );
  if (guidance.length > 0) {
    lines.push("", "## Your guidance at approval", "");
    for (const note of guidance) lines.push(`- ${note.text}`);
  }

  if (stage.subtasks.length === 0) {
    lines.push("", "_This stage has no subtasks yet._");
    return lines.join("\n");
  }

  for (const subtask of stage.subtasks) {
    lines.push("", "---", "", ...formatSubtask(subtask));
  }

  const checklist = stage.checklist ?? [];
  if (checklist.length > 0) {
    lines.push("", "## Verification items raised", "");
    for (const item of checklist) {
      lines.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
    }
  }

  return lines.join("\n");
}

/**
 * Overlays the work a subtask has done so far onto the stage, for a report open
 * while the stage is still running.
 *
 * Needed because activity only reaches the persisted subtask when the run ends,
 * so a report of a running stage would otherwise say it had done nothing — the
 * exact moment someone is most likely to be watching it.
 */
export function withLiveActivity(
  stage: TaskStage,
  live: { subtaskId: string; activity: SubtaskActivity } | undefined,
): TaskStage {
  if (!live) return stage;
  const index = stage.subtasks.findIndex((s) => s.id === live.subtaskId);
  if (index === -1) return stage;

  const subtasks = [...stage.subtasks];
  subtasks[index] = { ...subtasks[index], activity: live.activity };
  return { ...stage, subtasks };
}

function formatSubtask(subtask: Subtask): string[] {
  const lines: string[] = [`## ${subtask.title}`, "", `Status: ${subtask.status}`];
  if (subtask.startedAt) lines.push(`Started: ${subtask.startedAt}`);
  if (subtask.finishedAt) lines.push(`Finished: ${subtask.finishedAt}`);
  if (subtask.sessionId) lines.push(`Session: \`${subtask.sessionId}\``);
  if (subtask.failureReason) lines.push("", `**Failed:** ${subtask.failureReason}`);

  const activity = subtask.activity;
  if (!activity) {
    // Said explicitly rather than left blank: an empty section reads as "it did
    // nothing", when the truth is that this subtask ran before activity was kept.
    // Falls through rather than returning, because the reply may still be there —
    // and a stage that failed with an explanation is the one most worth reading.
    lines.push("", "_No activity was recorded for this subtask._");
    return withReply(lines, subtask);
  }

  const tools = Object.entries(activity.toolCounts ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  if (tools.length > 0) {
    lines.push(
      "",
      `**Tools used:** ${tools.map(([name, count]) => `${name}×${count}`).join(", ")}`,
    );
  }

  if ((activity.pathsWritten ?? []).length > 0) {
    lines.push("", "### Files changed", "");
    for (const path of activity.pathsWritten ?? []) lines.push(`- \`${path}\``);
  }

  if ((activity.commands ?? []).length > 0) {
    lines.push("", "### Commands run", "", "```");
    for (const command of activity.commands ?? []) lines.push(command);
    lines.push("```");
  }

  if (activity.output?.trim()) {
    lines.push("", "### Output", "", "```", activity.output.trimEnd(), "```");
  }

  if ((activity.pathsRead ?? []).length > 0) {
    // Last and collapsed: useful for "what did it base this on", but long and
    // rarely the thing being looked for.
    lines.push(
      "",
      "<details><summary>Files read (" + (activity.pathsRead?.length ?? 0) + ")</summary>",
      "",
    );
    for (const path of activity.pathsRead ?? []) lines.push(`- \`${path}\``);
    lines.push("", "</details>");
  }

  return withReply(lines, subtask);
}

/** Appends the agent's own words, which are worth having whatever else is missing. */
function withReply(lines: string[], subtask: Subtask): string[] {
  if (subtask.reply?.trim()) {
    lines.push("", "### What the agent reported", "", subtask.reply.trim());
  }
  return lines;
}

/** Every stage of a task, for "show me everything this task has done". */
export function formatTaskReport(
  taskName: string,
  pipeline: TaskPipeline | undefined,
): string {
  if (!pipeline || pipeline.stages.length === 0) {
    return `# ${taskName}\n\n_This task has no route, so there is nothing to report._`;
  }
  const parts = [
    `# ${taskName}`,
    "",
    `Route: ${pipeline.routeLabel ?? pipeline.routeId} · ${pipeline.stages.length} stages`,
  ];
  // Stages that never ran are listed but not expanded: a report mostly made of
  // "pending" hides the part worth reading.
  const ran = pipeline.stages.filter((s) => s.subtasks.some((t) => t.activity || t.reply));
  const untouched = pipeline.stages.filter((s) => !ran.includes(s));
  for (const stage of ran) {
    parts.push("", "", formatStageReport(taskName, stage, pipeline));
  }
  if (untouched.length > 0) {
    parts.push("", "", "## Not yet run", "");
    for (const stage of untouched) {
      parts.push(`- ${stage.name} (${stage.status})`);
    }
  }
  return parts.join("\n");
}
