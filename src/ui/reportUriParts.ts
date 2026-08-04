/**
 * The naming and identity of a "what did this do" report document.
 *
 * Pure and separate from the provider so the round-trip is tested: the query is
 * the only thing that tells the provider *which* task and stage to re-render, so
 * a lossy encoding would silently serve the wrong report — or, worse, an empty
 * one that reads as "this stage did nothing".
 */

export interface ReportTarget {
  taskId: string;
  /** Absent for a whole-task report. */
  stageId?: string;
}

export function encodeReportTarget(target: ReportTarget): string {
  const parts = [`task=${encodeURIComponent(target.taskId)}`];
  if (target.stageId) parts.push(`stage=${encodeURIComponent(target.stageId)}`);
  return parts.join("&");
}

export function decodeReportTarget(query: string): ReportTarget | undefined {
  const fields = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    if (index === -1) continue;
    fields.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
  }
  const taskId = fields.get("task");
  if (!taskId) return undefined;
  const stageId = fields.get("stage");
  return stageId ? { taskId, stageId } : { taskId };
}

/**
 * The document's file name, which is what the editor tab and the preview title
 * show. Ends in `.md` so the preview renders it as markdown rather than text.
 */
export function reportFileName(taskName: string, stageName?: string): string {
  const parts = [taskName, stageName].filter(Boolean).map((part) => slug(part as string));
  const name = parts.filter(Boolean).join(" — ") || "report";
  return `${name}.md`;
}

function slug(value: string): string {
  // Spaces are kept: this is a display name, and "Runtime QA Checklist" reads
  // better in a tab than "Runtime-QA-Checklist". Only characters a URI path or a
  // file name cannot carry are replaced.
  return value
    .replace(/[\\/:*?"<>|#%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
