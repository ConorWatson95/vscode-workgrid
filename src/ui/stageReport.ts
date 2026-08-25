import { Subtask, SubtaskActivity, TaskStage, TaskPipeline } from "../domain/taskPipeline";
import {
  findingsOfSubtasks,
  formatFindings,
  summariseFindings,
} from "../domain/reviewFindings";
import { redactSecrets } from "../domain/secretRedaction";
import { approvalAdvice, formatApprovalAdvice } from "../domain/approvalAdvice";
import { stageEvidence, summariseEvidence } from "../domain/stageEvidence";
import { checklistGates, gateFor } from "../domain/checklistScope";
import {
  UsageTotals,
  discardedUsage,
  hasUsage,
  pipelineUsage,
  rerunCounts,
  stageUsage,
  subtasksUsage,
  workingMs,
} from "../domain/stageUsage";
import { correctionCost } from "../domain/correctionCost";
import { roundHeading, stageRounds, summariseStageHistory } from "../domain/stageHistory";
import { hasGateWait, summariseGateWait } from "../domain/gateWait";

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
 * A gate wait, which is measured in days rather than minutes.
 *
 * `formatElapsed` tops out at hours, which is right for a session and useless for a
 * sign-off that sat over a weekend: "58h 20m" is a number the reader has to do
 * arithmetic on before it means anything.
 */
function formatWaitSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    // Not "3h 0m": `formatElapsed` prints the zero because a session's seconds are
    // worth having, and on a two-day wait the trailing unit is noise.
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

/**
 * Where a route's calendar time went while nothing was running, or undefined when no
 * gate has waited.
 *
 * The line exists to answer one question a wall-clock figure cannot: *should this
 * route have been faster?* Time in "with others" is time the harness was working
 * correctly — a task handed to testers and off the operator's desk is the throughput
 * the whole thing is for — and lumped in with a gate the operator sat on for a day it
 * reads as the same failure. Open waits are named separately because they are still
 * growing, and `unmeasured` is announced for the reason every other total here
 * announces it: a figure quietly missing two gates looks like a faster route.
 */
export function formatGateWaitLine(
  pipeline: TaskPipeline,
  now: number,
): string | undefined {
  const summary = summariseGateWait(pipeline, now);
  if (!hasGateWait(summary)) return undefined;

  const parts: string[] = [];
  if (summary.othersMs > 0) parts.push(`${formatWaitSpan(summary.othersMs)} with others`);
  if (summary.yoursMs > 0) parts.push(`${formatWaitSpan(summary.yoursMs)} with you`);
  if (summary.openOthersMs > 0) {
    parts.push(`${formatWaitSpan(summary.openOthersMs)} still with others`);
  }
  if (summary.openYoursMs > 0) {
    parts.push(`${formatWaitSpan(summary.openYoursMs)} still with you`);
  }
  if (summary.unmeasured > 0) {
    parts.push(
      summary.unmeasured === 1
        ? "1 gate not measured"
        : `${summary.unmeasured} gates not measured`,
    );
  }
  if (parts.length === 0) return undefined;

  return `**Waiting at gates:** ${parts.join(" · ")}`;
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
  if (totals.elapsedMs > 0) {
    // Split when a wait was recorded, and only then. Absence of a wait means
    // unmeasured rather than zero, so printing "0s waiting" on every stage that ran
    // before this existed would state something the record cannot support — and a
    // number shown always is a number read never.
    parts.push(
      totals.blockedOnHumanMs > 0
        ? `${formatElapsed(workingMs(totals))} working, ` +
          `${formatElapsed(totals.blockedOnHumanMs)} waiting on you`
        : `${formatElapsed(totals.elapsedMs)} in session`,
    );
  }

  const { input, output, cacheRead, cacheCreation } = totals.tokens;
  if (input + output + cacheRead + cacheCreation > 0) {
    const fresh = input + cacheCreation;
    const share = fresh + cacheRead > 0 ? Math.round((cacheRead / (fresh + cacheRead)) * 100) : 0;
    parts.push(
      `${formatTokens(fresh)} in (${formatTokens(cacheRead)} cached, ${share}%)`,
      `${formatTokens(output)} out`,
    );
  }

  // Named rather than assumed: the requested model is not evidence of what ran.
  if (totals.models.length > 0) parts.push(`on ${totals.models.join(", ")}`);

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

/**
 * What re-runs cost, and which stages they were.
 *
 * Undefined when nothing has been discarded, so a route that never went backwards
 * says nothing rather than printing a zero.
 *
 * Two figures, because they answer different questions: the share of the total tells
 * you whether the churn is the problem, and the per-stage list tells you *which*
 * problem — one expensive stage re-run repeatedly needs splitting, a route that
 * churns everywhere needs its reviews moving.
 */
export function formatRerunLine(pipeline: TaskPipeline): string | undefined {
  const gone = discardedUsage(pipeline);
  if (!hasUsage(gone)) return undefined;

  const total = pipelineUsage(pipeline).costUsd;
  const share = total > 0 ? Math.round((gone.costUsd / total) * 100) : 0;
  const worst = rerunCounts(pipeline)
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.stageName} ×${entry.times}` +
        (entry.costUsd > 0 ? ` ($${entry.costUsd.toFixed(2)})` : ""),
    )
    .join(", ");

  return (
    `**Discarded to re-runs:** $${gone.costUsd.toFixed(4)}` +
    (share > 0 ? ` — ${share}% of the total above` : "") +
    (worst ? ` · ${worst}` : "")
  );
}

/**
 * How much of the re-run cost was work that was actually wrong.
 *
 * Sits under `formatRerunLine` because it answers the next question that line
 * provokes: a route that discarded 40% of its spend is either paying to redo
 * defective work or paying because one fix invalidated fourteen stages, and those
 * have opposite remedies. Undefined unless something was discarded *and* a share
 * could be worked out, so a route with no money recorded says nothing here rather
 * than reporting a proportion of zero.
 */
export function formatCorrectionCostLine(pipeline: TaskPipeline): string | undefined {
  const summary = correctionCost(pipeline);
  if (summary.collateralShare === undefined) return undefined;

  const worst = summary.events
    .filter((event) => event.collateralStageNames.length > 0)
    .sort((a, b) => b.collateralCostUsd - a.collateralCostUsd)[0];

  return (
    `**Of that, collateral:** $${summary.collateralCostUsd.toFixed(4)}` +
    ` — ${summary.collateralShare}% was stages re-opened for standing after the one that changed` +
    (worst
      ? ` · worst: ${worst.collateralStageNames.length} stage(s) after` +
        ` ${worst.targetStageName ?? "a correction"}`
      : "")
  );
}

/** One stage's report. */
/**
 * Hard ceiling on a rendered report, in characters.
 *
 * A backstop, not the mechanism. `formatTaskReport` no longer embeds stage reports and
 * `MAX_OUTPUT_CHARS` caps command output per subtask — but neither bounds a *stage*,
 * which carries one subtask's cap per subtask it has, and a split stage that ran three
 * times through corrections carries all of them. Real stages reached 79KB.
 *
 * The number is chosen against the reader, not the renderer: nobody reads 60,000
 * characters of shell output, and a document that will not open is worth less than a
 * truncated one. Truncation is announced for the same reason the activity watcher
 * announces it — output that simply stops reads as the command having stopped.
 */
export const MAX_REPORT_CHARS = 60000;

/**
 * What stands in for a superseded round's body.
 *
 * Said rather than left blank, for the reason truncated output and a discarded file are
 * both announced: a `<details>` that opens on nothing reads as the record having been
 * lost.
 */
function supersededNote(): string {
  return (
    "_Superseded by a later round. Its findings were carried forward into the version " +
    "that stands; the full text is kept in the task state file._"
  );
}

/** Cuts an over-long report at a line boundary and says so. */
function capReport(markdown: string): string {
  if (markdown.length <= MAX_REPORT_CHARS) return markdown;
  const cut = markdown.slice(0, MAX_REPORT_CHARS);
  const at = cut.lastIndexOf("\n");
  return (
    (at > MAX_REPORT_CHARS / 2 ? cut.slice(0, at) : cut) +
    "\n\n---\n\n_This report was truncated here: it exceeded " +
    `${Math.round(MAX_REPORT_CHARS / 1000)}k characters, which the markdown preview ` +
    "will not open. The full record is in the task state file; the usual cause is a " +
    "stage with several subtasks, each carrying its own cap of captured command output._"
  );
}

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
  // Above everything the stage said, because it decides how the rest of the document
  // is read: a corrected stage carries several accounts of itself and only the last
  // one stands. Absent on a stage nothing has corrected, so the common case is
  // unchanged.
  const history = summariseStageHistory(stage);
  if (history) lines.push(`**How it got here:** ${history}  `);
  // The verdict is stripped out of the reply before it is stored, so this is the
  // only place it appears. A held stage whose verdict said nothing on screen was
  // indistinguishable from a clean one.
  // Named even when it passed. The whole point of a declared check is that the
  // outcome came from a process rather than the agent's word for it, and a reader
  // cannot tell which they are looking at unless the report says.
  if (stage.verify) {
    lines.push(`**Verified by:** \`${redactSecrets(stage.verify)}\`  `);
  }
  // The line above says what was *declared*; this says what actually backs the
  // outcome. For most stages the honest answer is "the session ended without an
  // error", and that used to be indistinguishable in the report from a green build.
  const evidence = stageEvidence(stage);
  if (evidence.basis !== "none") {
    lines.push(
      `**What backs this:** ${evidence.selfReported ? "⚠ self-reported — " : ""}` +
        `${redactSecrets(evidence.summary)}  `,
    );
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
    return capReport(redactSecrets(lines.join("\n")));
  }

  // A review's findings, then what the agent said, then everything else. This order
  // is the answer to "I always find myself scrolling forever": the reply is what the
  // report is opened for, and it used to sit at the very bottom, under the tool
  // counts, the file lists, the commands and their output.
  const findings = findingsOfSubtasks(stage.subtasks);
  if (findings.length > 0) {
    lines.push(
      "",
      `## Findings — ${summariseFindings(findings)}`,
      "",
      formatFindings(findings),
    );
  }

  // Rounds rather than subtasks: a repair is labelled with what it was asked to fix
  // and whether the stage got its own work wrong or had the ground moved under it,
  // and the round that stands is named as such. Superseded repairs are folded away on
  // a settled stage — the finding is in the summary line, so the reader can tell what
  // is inside without opening it, which is what makes folding it honest.
  const rounds = stageRounds(stage);
  const runRounds = rounds.filter((round) => round.kind === "run").length;
  // `awaiting-approval` folds too, and it is the status that matters most. The rule was
  // "settled only", on the reasoning that somebody reading a held stage is watching a
  // repair rather than reading a conclusion. That is true of a stage still working and
  // false of one at a gate: a stage awaiting approval has finished, and the reader is
  // there to decide whether to accept it. Held open, a review corrected and amended nine
  // times rendered ten full accounts of itself — around 30,000 characters of
  // near-identical text — at the one moment a person has to find the finding that is
  // still outstanding. `active`, `failed` and `pending` still show everything, which is
  // the case the original rule was written for.
  const foldRepairs =
    (stage.status === "passed" ||
      stage.status === "skipped" ||
      stage.status === "awaiting-approval") &&
    rounds.filter((round) => round.kind !== "run").length > 1;
  for (const round of rounds) {
    const heading = roundHeading(round, rounds.length > 1);
    const body = formatSubtaskReply(round.subtask, heading !== undefined);
    // The base run folds too once a repair has superseded it, but only when there is
    // exactly one — a split stage's parallel units are all `run` rounds and each holds a
    // different part of the answer, which is what the kind test was protecting.
    const fold =
      foldRepairs && !round.latest && (round.kind !== "run" || runRounds === 1);
    lines.push("", "---", "");
    if (heading && fold) {
      // The heading only. Folding kept every superseded body in the document, so a
      // stage repaired nine times still rendered around 30,000 characters of
      // near-identical review text — and this report was truncated at 60k, which is the
      // one failure mode that loses the *end* of the standing round. A superseded round
      // is not evidence a reader is looking for; what they need is that it happened and
      // what it was asked to fix, which the heading carries. The full text stays in the
      // state file, and the note says so rather than implying it is gone.
      lines.push(`<details><summary>${heading}</summary>`, "", supersededNote(), "", "</details>");
    } else {
      if (heading) {
        lines.push(`## ${heading}${round.latest ? " · the version that stands" : ""}`, "");
      }
      lines.push(...body);
    }
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
    // The gate an item is destined for, named where it is scoped. Named rather than left
    // implicit because the two verifications ask different questions — does it behave,
    // versus does it work where it is served — and an item read at the wrong one is a
    // false pass. Unscoped items carry nothing, so a route that declares no scopes
    // renders exactly as before.
    const gates = pipeline ? checklistGates(pipeline) : [];
    for (const item of checklist) {
      const destination =
        item.scope && gates.length > 0
          ? gateFor(gates, item.scope)?.stageName
          : undefined;
      lines.push(
        `- [${item.checked ? "x" : " "}] ${item.text}` +
          (destination ? `  _(${destination})_` : ""),
      );
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
  // A superseded round's mechanics go entirely, on the same reasoning as its body and
  // for a sharper reason: this is where the size is. Command output is capped per
  // *subtask*, so a stage with ten of them carries ten times the cap, and folding the
  // replies alone still left this report over 60k — truncated, which loses the end of
  // the standing round, the one part a reader is there for. What the superseded round
  // ran is in the state file; that it ran and what it was asked to fix is in its
  // heading above.
  const superseded = new Set(
    foldRepairs
      ? rounds
          .filter((round) => !round.latest && (round.kind !== "run" || runRounds === 1))
          .map((round) => round.subtask.id)
      : [],
  );
  for (const subtask of stage.subtasks) {
    if (superseded.has(subtask.id)) continue;
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

  return capReport(redactSecrets(lines.join("\n")));
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
 * `headed` says a round heading has already been printed above it, which is the case
 * for every subtask of a split or corrected stage.
 *
 * Split from the mechanics because the reply used to come *after* the tool counts,
 * the file lists, the commands and their output — so reading a finished stage's
 * conclusion meant scrolling past everything that produced it.
 */
function formatSubtaskReply(subtask: Subtask, headed: boolean): string[] {
  const lines: string[] = [];
  if (subtask.reply?.trim()) {
    // The round's own heading already says whose account this is, and what it was
    // asked to fix. A second heading under it repeated on every round is the noise a
    // corrected stage had four of.
    if (!headed) lines.push("## What the agent reported", "");
    lines.push(subtask.reply.trim());
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
/**
 * One line per stage for the whole-task view: outcome, what backs it, what it cost.
 *
 * Everything a reader of the route-level report is actually asking. The stage's own
 * report holds the rest, and embedding it here is what made this document unopenable.
 */
function formatStageSummary(stage: TaskStage): string {
  const bits: string[] = [`**${stage.name}** — ${stage.status}`];
  const evidence = stageEvidence(stage);
  if (evidence.basis !== "none") {
    bits.push(`${evidence.selfReported ? "⚠ " : ""}${redactSecrets(evidence.summary)}`);
  }
  if (stage.verdict) bits.push(`verdict: ${stage.verdict}`);
  const usage = formatUsageLine(stageUsage(stage));
  if (usage) bits.push(usage);
  const line = `- ${bits.join(" · ")}`;
  // The one thing that must never be summarised away: a stage held because it says it
  // did not do its work. That is the reader's reason for opening the report.
  return stage.blocked
    ? `${line}
  - **Did not do its work:** ${redactSecrets(stage.blocked)}`
    : line;
}

export function formatTaskReport(
  taskName: string,
  pipeline: TaskPipeline | undefined,
  /** Injected so an open gate wait can be measured without this module reading a clock. */
  now: number = Date.now(),
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
  // Beside the execution total, never folded into it. The two come from different
  // records — sessions versus gates — and the reason for showing them together is that
  // "62m of session, 3 days with testers" is the only honest account of a route whose
  // wall clock says three days.
  const waiting = formatGateWaitLine(pipeline, now);
  if (waiting) parts.push("", waiting);
  // Named separately, immediately under the total it is part of. A route that spent
  // two thirds of its money on work it threw away has one problem, and it is not the
  // one a single figure suggests.
  const churn = formatRerunLine(pipeline);
  if (churn) parts.push("", churn);
  // Directly under it, because the split is what makes the churn figure actionable
  // rather than just alarming.
  const collateral = formatCorrectionCostLine(pipeline);
  if (collateral) parts.push("", collateral);
  // The proportion, which no per-stage line can give: "how much of this route
  // actually proved anything?" Omitted entirely when the answer is "all of it",
  // because a reassurance printed every time stops being read.
  const weak = summariseEvidence(pipeline);
  if (weak) parts.push("", `**Evidence:** ${weak}`);
  // Stages that never ran are listed but not expanded: a report mostly made of
  // "pending" hides the part worth reading.
  const ran = pipeline.stages.filter((s) => s.subtasks.some((t) => t.activity || t.reply));
  const untouched = pipeline.stages.filter((s) => !ran.includes(s));

  // Summarised, not concatenated. This used to embed every stage's full report, and
  // on a real 22-stage route that rendered to 394KB of markdown -- which VS Code's
  // preview will not open, so the button that produces it appeared to do nothing at
  // all. Command output is what fills it: capped per *subtask*, so a stage with three
  // of them carries three times the cap, and the route carries the sum of all of it.
  //
  // The detail has not gone anywhere; it is one click away on the stage row. What the
  // whole-task view is actually for is the shape of the route -- where the money went,
  // what is backed by something, what is held -- and none of that was legible under a
  // third of a megabyte of shell output.
  if (ran.length > 0) {
    parts.push("", "", "## Stages that have run", "");
    for (const stage of ran) parts.push(formatStageSummary(stage));
    parts.push("", "_Open a stage in the tree and choose \"Show What This Did\" for its" +
      " commands, output and replies._");
  }
  if (untouched.length > 0) {
    parts.push("", "", "## Not yet run", "");
    for (const stage of untouched) {
      parts.push(`- ${stage.name} (${stage.status})`);
    }
  }
  return capReport(parts.join("\n"));
}
