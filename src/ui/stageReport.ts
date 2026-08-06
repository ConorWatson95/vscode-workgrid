import { Subtask, SubtaskActivity, TaskStage, TaskPipeline } from "../domain/taskPipeline";
import {
  formatFindings,
  parseReviewFindings,
  summariseFindings,
} from "../domain/reviewFindings";
import { redactSecrets } from "../domain/secretRedaction";
import { approvalAdvice, formatApprovalAdvice } from "../domain/approvalAdvice";
import {
  UsageTotals,
  hasUsage,
  pipelineUsage,
  stageUsage,
  subtasksUsage,
} from "../domain/stageUsage";

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

/** Compact token count: 128_400 -> "128.4k". Full precision below 10,000. */
function formatTokens(count: number): string {
  if (count < 10_000) return count.toLocaleString("en-GB");
  return `${(count / 1000).toFixed(1)}k`;
}

/** "4m 12s" — a duration a reader can compare against another run at a glance. */
function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One line of "what this cost", or undefined when nothing was measured.
 *
 * A single line by design. It exists to make two runs of the same route
 * comparable — a cheaper model on a stage, a narrower tool set, a handover brief
 * instead of rediscovery — and a table nobody reads would not do that. The cached
 * share is called out because with a fresh session per subtask it is the number
 * that says whether any of the prompt preamble was reused at all.
 */
export function formatUsageLine(totals: UsageTotals): string | undefined {
  if (!hasUsage(totals)) return undefined;

  const parts: string[] = [];
  if (totals.costUsd > 0) parts.push(`$${totals.costUsd.toFixed(4)}`);
  if (totals.elapsedMs > 0) parts.push(`${formatElapsed(totals.elapsedMs)} in session`);

  const { input, output, cacheRead, cacheCreation } = totals.tokens;
  if (input + output + cacheRead + cacheCreation > 0) {
    const fresh = input + cacheCreation;
    const share = fresh + cacheRead > 0 ? Math.round((cacheRead / (fresh + cacheRead)) * 100) : 0;
    parts.push(
      `${formatTokens(fresh)} in (${formatTokens(cacheRead)} cached, ${share}%)`,
      `${formatTokens(output)} out`,
    );
  }

  if (parts.length === 0) return undefined;

  // Said out loud rather than left to be inferred from a small-looking total. Two
  // runs are only comparable if they measured the same work, and a total quietly
  // missing three subtasks looks like an improvement.
  //
  // Worded on whether there is a total to be partial *about*: a stage that ran
  // before any of this was recorded has a real elapsed time and no money at all,
  // and calling that a partial total invites a reader to compare it with one.
  let caveat = "";
  if (totals.unmeasured > 0) {
    caveat =
      totals.measured > 0
        ? ` · ${totals.unmeasured} subtask(s) reported no usage, so this total is partial`
        : ` · no cost was recorded for ${totals.unmeasured} subtask(s)`;
  }
  return `**Cost:** ${parts.join(" · ")}${caveat}`;
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
  // The verdict is stripped out of the reply before it is stored, so this is the
  // only place it appears. A held stage whose verdict said nothing on screen was
  // indistinguishable from a clean one.
  // Named even when it passed. The whole point of a declared check is that the
  // outcome came from a process rather than the agent's word for it, and a reader
  // cannot tell which they are looking at unless the report says.
  if (stage.verify) {
    lines.push(`**Verified by:** \`${redactSecrets(stage.verify)}\`  `);
  }
  if (stage.verdict) {
    lines.push(
      `**The review's verdict:** ${stage.verdict === "block" ? "block" : "pass"}  `,
    );
  }
  // Same reasoning as the verdict, one line up: this stage is held, and the reader
  // opened the report to find out why. The marker is stripped from the reply, so
  // without this the reply reads as an ordinary account of work that did not happen.
  if (stage.blocked) {
    lines.push(`**This stage did not do its work:** ${stage.blocked}  `);
  }
  // In the header rather than down with the mechanics: the stage total is the
  // figure a route is tuned on, and burying it under the output of the commands
  // that produced it is how it went unrecorded for this long.
  const usage = formatUsageLine(stageUsage(stage));
  if (usage) lines.push(`${usage}  `);

  // What is being asked of the reader, and what to do about it, above everything
  // else — a gate that presents only evidence makes the reader derive the question.
  if (stage.status === "awaiting-approval" && pipeline) {
    lines.push("", formatApprovalAdvice(approvalAdvice(pipeline, stage)));
  }

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

  if (stage.subtasks.length === 0) {
    lines.push("", "## Intent", "", stage.intent, "", "_This stage has no subtasks yet._");
    return redactSecrets(lines.join("\n"));
  }

  // A review's findings, then what the agent said, then everything else. This order
  // is the answer to "I always find myself scrolling forever": the reply is what the
  // report is opened for, and it used to sit at the very bottom, under the tool
  // counts, the file lists, the commands and their output.
  const findings = parseReviewFindings(
    stage.subtasks.map((subtask) => subtask.reply ?? "").join("\n\n"),
  );
  if (findings.length > 0) {
    lines.push(
      "",
      `## Findings — ${summariseFindings(findings)}`,
      "",
      formatFindings(findings),
    );
  }

  for (const subtask of stage.subtasks) {
    lines.push("", "---", "", ...formatSubtaskReply(subtask, stage.subtasks.length > 1));
  }

  // Ahead of the checklist and the declined work, because for a stage that executes a
  // plan this *is* the report: the question a reader has is which of the numbered
  // steps actually happened, and the answer used to be nowhere at all.
  const planSteps = stage.planSteps ?? [];
  if (planSteps.length > 0) {
    lines.push("", `## Plan steps — ${stage.planFile ?? "its plan"}`, "");
    for (const step of planSteps) {
      const state =
        step.status === "done"
          ? "**done**"
          : step.status === "not-done"
            ? "**not done**"
            : "**unaccounted for** — this stage cannot pass until it says what happened";
      lines.push(`- ${step.number}. ${step.title} — ${state}${step.note ? `: ${step.note}` : ""}`);
    }
  }

  const checklist = stage.checklist ?? [];
  if (checklist.length > 0) {
    lines.push("", "## Verification items raised", "");
    for (const item of checklist) {
      lines.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
    }
  }

  // Above the guidance, because a held route is usually what the report was
  // opened to explain. The resolution is shown too: an item settled with a reason
  // is the record of a decision, and stripping it back to "resolved" would lose
  // exactly the knowledge whose absence caused the hold.
  const declined = (pipeline?.deferrals ?? []).filter(
    (item) => item.raisedByStage === stage.id,
  );
  if (declined.length > 0) {
    lines.push("", "## Work it declined as belonging elsewhere", "");
    for (const item of declined) {
      lines.push(
        `- ${item.text}` +
          (item.resolved
            ? ` — **settled:** ${item.resolution ?? "no reason recorded"}`
            : " — **outstanding**, and a stage that ships will hold until it has an owner"),
      );
    }
  }

  const guidance = (pipeline?.guidance ?? []).filter(
    (note) => note.stageId === stage.id,
  );
  if (guidance.length > 0) {
    lines.push("", "## Your guidance at approval", "");
    for (const note of guidance) lines.push(`- ${note.text}`);
  }

  // Below the reply, because it is the instruction the stage was given rather than
  // anything it found out — you wrote it, and it is in the route.
  lines.push("", "## Intent", "", stage.intent);

  // The mechanics last, and collapsed once the stage has settled cleanly. They are
  // what you want while a stage runs or when one has gone wrong, and noise when you
  // are reading a finished stage's conclusion.
  const settled = stage.status === "passed" || stage.status === "skipped";
  for (const subtask of stage.subtasks) {
    const detail = formatSubtaskDetail(subtask);
    if (detail.length === 0) continue;
    const heading = `What ${stage.subtasks.length > 1 ? `"${subtask.title}"` : "it"} did — tools, commands and output`;
    lines.push(
      "",
      ...(settled
        ? [`<details><summary>${heading}</summary>`, "", ...detail, "", "</details>"]
        : [`## ${heading}`, "", ...detail]),
    );
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

/**
 * The half of a subtask a reader opens the report for: what the agent said.
 *
 * Split from the mechanics because the reply used to come *after* the tool counts,
 * the file lists, the commands and their output — so reading a finished stage's
 * conclusion meant scrolling past everything that produced it.
 */
function formatSubtaskReply(subtask: Subtask, name: boolean): string[] {
  const lines: string[] = [];
  if (name) lines.push(`## ${subtask.title}`, "");

  if (subtask.reply?.trim()) {
    lines.push("## What the agent reported", "", subtask.reply.trim());
  } else if (subtask.status === "failed" && !subtask.activity) {
    // Distinguished from "nothing was recorded", because they read identically and
    // mean opposite things: one invites the reader to go looking for what it did,
    // this says there is nothing to find.
    lines.push(
      "_The session failed without calling a single tool, so there is nothing to show " +
        "for it — the reason above is the whole of what happened._",
    );
  } else if (!subtask.reply?.trim()) {
    lines.push(`_This subtask recorded no reply. Status: ${subtask.status}._`);
  }
  return lines;
}

/**
 * The mechanics: tools, files, commands, output. Collapsed by the caller once a
 * stage has settled cleanly — wanted while a stage runs or when one went wrong, and
 * noise when reading a finished stage's conclusion.
 *
 * Returns an empty list when there is nothing to show, so the caller can omit the
 * section rather than render an empty one.
 */
function formatSubtaskDetail(subtask: Subtask): string[] {
  const lines: string[] = [];
  if (subtask.startedAt) lines.push(`Started: ${subtask.startedAt}  `);
  if (subtask.finishedAt) lines.push(`Finished: ${subtask.finishedAt}  `);
  if (subtask.sessionId) lines.push(`Session: \`${subtask.sessionId}\``);

  // Per subtask as well as per stage: a split stage's cost is rarely spread
  // evenly, and "which of these five was expensive" is the question that decides
  // what to change.
  const usage = formatUsageLine(subtasksUsage([subtask]));
  if (usage) lines.push("", usage);

  const activity = subtask.activity;
  if (!activity) {
    // Said explicitly rather than left blank: an empty section reads as "it did
    // nothing", when the truth is this subtask ran before activity was kept.
    if (subtask.status === "failed") return [];
    lines.push("", "_No activity was recorded for this subtask._");
    return lines;
  }

  const tools = Object.entries(activity.toolCounts ?? {}).sort((a, b) => b[1] - a[1]);
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

  // Above the files-read block: when a session fails, this is what is being looked
  // for, and it is often the only thing here.
  if ((activity.errors ?? []).length > 0) {
    lines.push("", "### Session errors", "");
    for (const error of activity.errors ?? []) {
      lines.push("```", error.trimEnd(), "```");
    }
  }

  if ((activity.pathsRead ?? []).length > 0) {
    // Last, and collapsed even inside the collapsed section: useful for "what did it
    // base this on", but long and rarely what is being looked for.
    lines.push(
      "",
      "<details><summary>Files read (" + (activity.pathsRead?.length ?? 0) + ")</summary>",
      "",
    );
    for (const path of activity.pathsRead ?? []) lines.push(`- \`${path}\``);
    lines.push("", "</details>");
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
  // The whole-route figure, which is the one a change to the harness is judged
  // on: a stage that got cheaper by pushing its work into the next stage has not
  // got cheaper.
  const total = formatUsageLine(pipelineUsage(pipeline));
  if (total) parts.push("", total);
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
