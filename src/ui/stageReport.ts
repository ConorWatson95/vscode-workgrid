import { Subtask, SubtaskActivity, TaskStage, TaskPipeline } from "../domain/taskPipeline";
import {
  formatFindings,
  parseReviewFindings,
  summariseFindings,
} from "../domain/reviewFindings";
import { redactSecrets } from "../domain/secretRedaction";

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

/**
 * Turns a failure reason into something a reader can act on.
 *
 * The reasons that matter most are the CLI's own machine-readable subtypes, which
 * say precisely what happened and nothing at all about what to do about it. A
 * reader seeing `error_max_turns` for the first time has to go and find out that
 * it means the stage ran out of turns rather than hit a bug in its work.
 */
export function describeFailure(reason: string | undefined): string {
  const text = reason?.trim();
  if (!text) return "The agent session failed without saying why.";

  if (text === "error_max_turns") {
    return (
      "`error_max_turns` — the agent used up its turn budget before finishing. " +
      "Usually a stage doing too much: narrow its intent, or split it."
    );
  }
  if (text === "error_during_execution") {
    return (
      "`error_during_execution` — the CLI itself failed mid-turn, rather than the " +
      "work being wrong. Re-running the stage is the first thing to try."
    );
  }
  if (/rate.?limit|429|usage limit/i.test(text)) {
    return `${text}\n\nRate-limited rather than wrong. The stage can be re-run once the limit resets.`;
  }
  if (/timed out after/i.test(text)) {
    return `${text}\n\nThe work may have been progressing — check the commands below. Raise \`taskWorkspaces.stageTimeoutMinutes\` if stages here legitimately take this long.`;
  }
  return text;
}

/** One stage's report. */
export function formatStageReport(
  taskName: string,
  stage: TaskStage,
  pipeline: TaskPipeline | undefined,
): string {
  // Redacted again at the end of this function, not only at capture. Capture-time
  // masking cannot help a task recorded by an earlier build, and this document is
  // the thing actually put in front of someone.
  const lines: string[] = [
    `# ${stage.name}`,
    "",
    `**Task:** ${taskName}  `,
    `**Stage:** \`${stage.id}\` · ${stage.kind} · ${stage.status}`,
  ];
  if (stage.model) lines.push(`**Model:** ${stage.model}  `);
  if (stage.addedByRule) lines.push(`**Added by rule:** ${stage.addedByRule}  `);

  // Above the intent, because someone opening the report of a failed stage is
  // asking one question. The reason was recorded per subtask and rendered halfway
  // down, under the tool counts, where it read as a footnote to a successful run.
  const failures = stage.subtasks.filter((subtask) => subtask.status === "failed");
  if (failures.length > 0) {
    lines.push("", "## ⚠ Failed", "");
    for (const subtask of failures) {
      const reason = subtask.failureReason?.trim();
      lines.push(
        failures.length > 1 ? `- **${subtask.title}:** ${describeFailure(reason)}` : describeFailure(reason),
      );
    }
    lines.push("", "_What it did before failing is below._");
  }

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
    return redactSecrets(lines.join("\n"));
  }

  for (const subtask of stage.subtasks) {
    lines.push("", "---", "", ...formatSubtask(subtask));
  }

  // Lifted out of the prose and put where a reader looks first. A review's whole
  // output is a list of things to do about the code, and it used to be buried in
  // whatever paragraphs the agent wrote around it.
  const findings = parseReviewFindings(
    stage.subtasks.map((subtask) => subtask.reply ?? "").join("\n\n"),
  );
  if (findings.length > 0) {
    lines.splice(
      lines.indexOf("## Intent"),
      0,
      `## Findings — ${summariseFindings(findings)}`,
      "",
      formatFindings(findings),
      "",
    );
  }

  const checklist = stage.checklist ?? [];
  if (checklist.length > 0) {
    lines.push("", "## Verification items raised", "");
    for (const item of checklist) {
      lines.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
    }
  }

  return redactSecrets(lines.join("\n"));
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
  // Not repeated in full: the reason is at the top of the report now, and the
  // point here is only to mark which subtask it belonged to.
  if (subtask.failureReason) lines.push("", `**Failed:** ${subtask.failureReason}`);

  const activity = subtask.activity;
  if (!activity && subtask.status === "failed") {
    // Distinguished from the case below, because they read identically and mean
    // opposite things. "No activity was recorded" invites the reader to look for
    // what it did; this says there is nothing to look for.
    lines.push(
      "",
      "_The session failed without calling a single tool, so there is nothing to show " +
        "for it — the reason above is the whole of what happened._",
    );
    return withReply(lines, subtask);
  }
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

  // Above the files-read block: when a session fails, this is what is being
  // looked for, and it is often the only thing here.
  if ((activity.errors ?? []).length > 0) {
    lines.push("", "### Session errors", "");
    for (const error of activity.errors ?? []) {
      lines.push("```", error.trimEnd(), "```");
    }
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
