import { TaskPipeline } from "./taskPipeline";

/**
 * A short fingerprint of a pipeline exactly as it is persisted.
 *
 * A client that shows a gate and later acts on it is acting on what it *showed*,
 * which may no longer be what is on disk: another window, a headless run or a
 * second client can have moved the route in between. The revision is what lets the
 * write refuse rather than apply a decision to state the person never saw — the
 * difference between "approve this" and "approve whatever is there now".
 *
 * Keyed on the pipeline alone, never the whole task. Reconciliation refreshes
 * `branchName` and the feedback poll records replies on the task; neither changes
 * what an approval or a retry is a decision about, and refusing on them would teach
 * people that the check fires for nothing.
 *
 * Pure (no `node:crypto`) so it lives in the domain. A 53-bit non-cryptographic
 * hash plus the length is ample for "has this changed since I looked": nothing here
 * is adversarial, and a collision costs one decision applied to a pipeline that
 * differs in some other respect — which is today's behaviour for every write.
 */
export function pipelineRevision(pipeline: TaskPipeline | undefined): string {
  const text = JSON.stringify(pipeline ?? null);
  return `${hash53(text).toString(36)}-${text.length.toString(36)}`;
}

/** cyrb53: two interleaved 32-bit multiplicative hashes. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
