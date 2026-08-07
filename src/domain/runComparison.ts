import { summariseInterventions } from "./interventions";
import { describeExperiment } from "./pipelineExperiment";
import { selfReportedStages } from "./stageEvidence";
import { UsageTotals, hasUsage, pipelineUsage, stageUsage } from "./stageUsage";
import { TaskPipeline } from "./taskPipeline";

/**
 * Two runs of a route, side by side.
 *
 * The measurement CLAUDE.md has described as "measurable but not yet measured": does
 * carrying a stage's conclusion forward cost less than letting the next stage
 * rediscover it? Every number needed has been recorded for a while. What was missing
 * was somewhere to put two of them next to each other, and — more importantly —
 * anything that says when the answer is not to be trusted.
 *
 * That is most of what this module is. A comparison is easy; a comparison that
 * refuses to mislead is the work. The failure mode is not a wrong number, it is a
 * right number about two runs that were not comparable — different routes, different
 * models, half the subtasks unmeasured — presented as though it settled something.
 *
 * Pure and vscode-free, so the arithmetic and the caveats are both tested.
 */

export interface RunSide {
  label: string;
  pipeline: TaskPipeline;
}

export interface StageComparison {
  stageId: string;
  name: string;
  /** Absent when this run has no such stage — see `warnings`. */
  a?: UsageTotals;
  b?: UsageTotals;
}

export interface RunComparison {
  a: { label: string; totals: UsageTotals; interventions: number; arm?: string };
  b: { label: string; totals: UsageTotals; interventions: number; arm?: string };
  stages: StageComparison[];
  /**
   * Everything that makes the numbers less than a conclusion.
   *
   * First-class rather than a footnote, and rendered above the totals. A comparison
   * is read for its bottom line, so a caveat printed underneath one is a caveat
   * nobody applied.
   */
  warnings: string[];
}

/** Percentage change from `from` to `to`, or undefined when there is no baseline. */
export function percentChange(from: number, to: number): number | undefined {
  if (from === 0) return undefined;
  return ((to - from) / from) * 100;
}

export function compareRuns(a: RunSide, b: RunSide): RunComparison {
  const totalsA = pipelineUsage(a.pipeline);
  const totalsB = pipelineUsage(b.pipeline);

  const stages: StageComparison[] = [];
  const seen = new Set<string>();
  for (const stage of a.pipeline.stages) {
    seen.add(stage.id);
    const other = b.pipeline.stages.find((s) => s.id === stage.id);
    stages.push({
      stageId: stage.id,
      name: stage.name,
      a: stageUsage(stage),
      b: other ? stageUsage(other) : undefined,
    });
  }
  for (const stage of b.pipeline.stages) {
    if (seen.has(stage.id)) continue;
    stages.push({ stageId: stage.id, name: stage.name, b: stageUsage(stage) });
  }

  return {
    a: {
      label: a.label,
      totals: totalsA,
      interventions: countInterventions(a.pipeline),
      arm: a.pipeline.experiment?.arm,
    },
    b: {
      label: b.label,
      totals: totalsB,
      interventions: countInterventions(b.pipeline),
      arm: b.pipeline.experiment?.arm,
    },
    stages,
    warnings: warningsFor(a, b, totalsA, totalsB, stages),
  };
}

function countInterventions(pipeline: TaskPipeline): number {
  return summariseInterventions(pipeline.interventions ?? []).total;
}

/**
 * Why these two runs might not be comparable.
 *
 * Ordered by how badly each one invalidates the comparison, because a reader stops
 * at the first line often enough that the order is the message.
 */
function warningsFor(
  a: RunSide,
  b: RunSide,
  totalsA: UsageTotals,
  totalsB: UsageTotals,
  stages: StageComparison[],
): string[] {
  const warnings: string[] = [];

  if (a.pipeline.routeId !== b.pipeline.routeId) {
    warnings.push(
      `These are different routes — \`${a.pipeline.routeId}\` and \`${b.pipeline.routeId}\`. ` +
        "The totals are not a comparison of anything.",
    );
  }

  // The one that silently ruins the experiment: two runs on the same arm measure the
  // difference between two tasks, which is noise, and read exactly like a result.
  const armA = a.pipeline.experiment?.arm;
  const armB = b.pipeline.experiment?.arm;
  if (!armA || !armB) {
    warnings.push(
      "At least one run records no experiment arm, so nothing states what was varied " +
        "between them. Any difference here is a difference between two tasks.",
    );
  } else if (armA === armB) {
    warnings.push(
      `Both runs are on the \`${armA}\` arm, so this measures the difference between ` +
        "two pieces of work rather than between two ways of running a route.",
    );
  }

  // Different models is the trap `actualModel` was recorded to catch: an org policy
  // substitutes a model without failing, so a run can be measuring a fallback.
  const modelsA = totalsA.models.join(", ");
  const modelsB = totalsB.models.join(", ");
  if (modelsA && modelsB && modelsA !== modelsB) {
    warnings.push(
      `Different models actually ran — ${modelsA} against ${modelsB}. Cost differences ` +
        "here are mostly the model, not the thing being tested.",
    );
  }

  const unmeasured = totalsA.unmeasured + totalsB.unmeasured;
  if (unmeasured > 0) {
    warnings.push(
      `${unmeasured} subtask(s) across both runs reported no usage, so at least one ` +
        "total is partial. A total quietly missing subtasks looks like an improvement.",
    );
  }

  const missing = stages.filter((stage) => !stage.a || !stage.b);
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} stage(s) exist in only one run (${missing
        .map((stage) => stage.name)
        .join(", ")}) — usually a rule-added review, which fires on what the diff ` +
        "touched and so is itself a difference between the two.",
    );
  }

  // Not a caveat about comparability, but about what a cheaper run is worth: a route
  // that got cheaper by proving less did not get cheaper.
  const weakA = selfReportedStages(a.pipeline).length;
  const weakB = selfReportedStages(b.pipeline).length;
  if (weakA !== weakB) {
    warnings.push(
      `The runs differ in how much they proved: ${weakA} self-reported stage(s) against ` +
        `${weakB}. A run that is cheaper because less of it was checked is not cheaper.`,
    );
  }

  return warnings;
}

/** Compact token count: 128_400 -> "128.4k". Matches the stage report's rendering. */
function formatTokens(count: number): string {
  if (count < 10_000) return count.toLocaleString("en-GB");
  return `${(count / 1000).toFixed(1)}k`;
}

function formatDelta(from: number, to: number, render: (n: number) => string): string {
  const change = percentChange(from, to);
  if (change === undefined) return "—";
  const sign = change > 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}% (${render(to - from)})`;
}

/** The comparison as markdown, for a read-only report document. */
export function formatRunComparison(comparison: RunComparison): string {
  const { a, b } = comparison;
  const lines: string[] = [
    "# Two runs, compared",
    "",
    `**A:** ${a.label}${a.arm ? ` · arm \`${a.arm}\`` : ""}  `,
    `**B:** ${b.label}${b.arm ? ` · arm \`${b.arm}\`` : ""}`,
  ];

  // Above the numbers, deliberately. A comparison is read for its bottom line, so a
  // caveat printed under one is a caveat nobody applied.
  if (comparison.warnings.length > 0) {
    lines.push("", "## ⚠ Read these first", "");
    for (const warning of comparison.warnings) lines.push(`- ${warning}`);
  }

  const freshA = a.totals.tokens.input + a.totals.tokens.cacheCreation;
  const freshB = b.totals.tokens.input + b.totals.tokens.cacheCreation;

  lines.push(
    "",
    "## Totals",
    "",
    "| | A | B | Change |",
    "|---|---|---|---|",
    `| Cost | $${a.totals.costUsd.toFixed(4)} | $${b.totals.costUsd.toFixed(4)} | ${formatDelta(a.totals.costUsd, b.totals.costUsd, (n) => `$${n.toFixed(4)}`)} |`,
    // Fresh input is the number the handoff question is actually about: a stage that
    // rediscovers reads files again, and that lands here rather than in cache reads.
    `| Fresh input tokens | ${formatTokens(freshA)} | ${formatTokens(freshB)} | ${formatDelta(freshA, freshB, formatTokens)} |`,
    `| Cached input | ${formatTokens(a.totals.tokens.cacheRead)} | ${formatTokens(b.totals.tokens.cacheRead)} | ${formatDelta(a.totals.tokens.cacheRead, b.totals.tokens.cacheRead, formatTokens)} |`,
    `| Output tokens | ${formatTokens(a.totals.tokens.output)} | ${formatTokens(b.totals.tokens.output)} | ${formatDelta(a.totals.tokens.output, b.totals.tokens.output, formatTokens)} |`,
    `| Time in session | ${Math.round(a.totals.elapsedMs / 1000)}s | ${Math.round(b.totals.elapsedMs / 1000)}s | ${formatDelta(a.totals.elapsedMs, b.totals.elapsedMs, (n) => `${Math.round(n / 1000)}s`)} |`,
    // The KPI, and the reason it is in the same table as cost: the harness exists to
    // let one person supervise several tasks, so a run that is cheaper and asks twice
    // as many questions has moved the wrong number.
    `| Interventions | ${a.interventions} | ${b.interventions} | ${formatDelta(a.interventions, b.interventions, (n) => `${n}`)} |`,
  );

  lines.push("", "## Per stage", "", "| Stage | A cost | B cost | A fresh in | B fresh in |", "|---|---|---|---|---|");
  for (const stage of comparison.stages) {
    const cell = (totals: UsageTotals | undefined, render: (t: UsageTotals) => string) =>
      totals && hasUsage(totals) ? render(totals) : "—";
    lines.push(
      `| ${stage.name} ` +
        `| ${cell(stage.a, (t) => `$${t.costUsd.toFixed(4)}`)} ` +
        `| ${cell(stage.b, (t) => `$${t.costUsd.toFixed(4)}`)} ` +
        `| ${cell(stage.a, (t) => formatTokens(t.tokens.input + t.tokens.cacheCreation))} ` +
        `| ${cell(stage.b, (t) => formatTokens(t.tokens.input + t.tokens.cacheCreation))} |`,
    );
  }

  return lines.join("\n");
}

/** The arm description for each side, for a report header. Undefined when neither has one. */
export function describeArms(a: TaskPipeline, b: TaskPipeline): string | undefined {
  const parts = [describeExperiment(a.experiment), describeExperiment(b.experiment)];
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length > 0 ? present.join("\n\n") : undefined;
}
