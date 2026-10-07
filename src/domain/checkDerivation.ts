import type { ChecklistItem, TaskPipeline, TaskStage } from "./taskPipeline";
import { coverageForGate, setItemCoverage } from "./checkCoverage";
import { producesChecklist } from "./taskRoute";
import { markerLine, markerText } from "./replyMarkers";

/**
 * Checks derived from a checklist written first, by three stages in that order.
 *
 * The checklist is the statement of what must be true and a check is one item's
 * implementation -- never a second list written beside it. The route that first split
 * check-writing into a stage of its own (`rc-write-checks`, 6 Oct 2026) broke exactly
 * that: the checks stage ran with no checklist to work from and wrote checks from the
 * ticket and plan, then the gate wrote its own checklist from the same specification.
 * Two lists, written for different reasons, and the join between them left to a person.
 * Measured on the checkbox-rename task: six items, two checks, two matches, and four
 * items no check would ever be written for, because they did not exist when the checks
 * stage ran -- one of them an item the suite could express and the gate said so.
 *
 * So the order is a property of the pipeline, derived rather than declared:
 *
 * - **A checklist writer** -- a `behaviourReview` stage -- writes the gate's items, in
 *   the suite's vocabulary, and writes no checks.
 * - **A checks stage** -- a non-checklist stage declaring the *same* `checkManifest`
 *   as the gate after it -- is handed those items by id and must account for each one,
 *   with the check that answers it or the capability that is missing.
 * - **The gate** reads: it runs the manifest and ticks what passed. It does not write a
 *   checklist of its own, which would be the second list again.
 *
 * Keyed on the manifest because that is the one declaration that says two stages are
 * about the same checks; keyed on nothing else, so a route that has not adopted the
 * shape behaves exactly as it did. Pure and vscode-free.
 */

function samePath(a: string | undefined, b: string | undefined): boolean {
  const norm = (path: string | undefined) =>
    path?.trim().replace(/\\/g, "/").toLowerCase() || undefined;
  const left = norm(a);
  return left !== undefined && left === norm(b);
}

function isResolved(stage: TaskStage): boolean {
  return stage.status === "passed" || stage.status === "skipped";
}

/** The stage that writes the checks a gate runs, and the one that wrote its checklist. */
export interface DelegatedAuthoring {
  checksStageId: string;
  /** Absent where the route has a checks stage and nothing writing a list ahead of it. */
  writerStageId?: string;
}

/**
 * Who authors this gate's checks, when it is not the gate.
 *
 * The checks stage is the nearest stage before the gate that declares the gate's
 * manifest and does not itself write a checklist. The writer is the nearest
 * `behaviourReview` before *that* -- a review after the checks stage would be writing a
 * list nobody implements, which is the defect this exists to end.
 */
export function delegatedAuthoring(
  pipeline: TaskPipeline,
  gateId: string,
): DelegatedAuthoring | undefined {
  const gateIndex = pipeline.stages.findIndex((stage) => stage.id === gateId);
  const gate = pipeline.stages[gateIndex];
  if (!gate?.checkManifest) return undefined;

  let checksIndex = -1;
  for (let i = gateIndex - 1; i >= 0; i--) {
    const candidate = pipeline.stages[i];
    if (!producesChecklist(candidate.kind) && samePath(candidate.checkManifest, gate.checkManifest)) {
      checksIndex = i;
      break;
    }
  }
  if (checksIndex < 0) return undefined;
  // Only the first gate after the checks stage is served by it. A later gate sharing the
  // manifest -- a DEV-site sign-off behind a local verification -- asks about another
  // environment, nothing upstream writes its list, and treating it as a reader would
  // leave it with no items at all. It goes on authoring its own, as it always has.
  if (gateServedBy(pipeline, pipeline.stages[checksIndex].id)?.id !== gateId) return undefined;

  let writer: TaskStage | undefined;
  for (let i = checksIndex - 1; i >= 0; i--) {
    const candidate = pipeline.stages[i];
    if (candidate.kind === "behaviourReview" && candidate.status !== "skipped") {
      writer = candidate;
      break;
    }
  }
  return {
    checksStageId: pipeline.stages[checksIndex].id,
    ...(writer ? { writerStageId: writer.id } : {}),
  };
}

/**
 * True when a gate's checklist is written upstream and the gate only reads it.
 *
 * Both halves are required. A checks stage with no writer ahead of it is the shape that
 * produced the defect, and there the gate must go on writing its list as it always has
 * -- otherwise nothing would write one at all, and a gate with no items has nothing for
 * a check to tick.
 */
export function gateReadsUpstreamChecklist(pipeline: TaskPipeline, gateId: string): boolean {
  const delegated = delegatedAuthoring(pipeline, gateId);
  return delegated?.writerStageId !== undefined;
}

/** The gate whose checks this stage writes: the first after it declaring its manifest. */
export function gateServedBy(pipeline: TaskPipeline, stageId: string): TaskStage | undefined {
  const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
  const stage = pipeline.stages[index];
  if (!stage?.checkManifest || producesChecklist(stage.kind)) return undefined;
  return pipeline.stages
    .slice(index + 1)
    .find(
      (candidate) =>
        candidate.kind === "humanVerification" &&
        samePath(candidate.checkManifest, stage.checkManifest),
    );
}

/**
 * The stage that will write checks for the list this review writes, if one exists.
 *
 * Read by the review's prompt, which then asks for the list alone. Without it the
 * review is told to write the checks as well, and the checks stage writes them again.
 */
export function checksStageFor(pipeline: TaskPipeline, writerId: string): TaskStage | undefined {
  const writerIndex = pipeline.stages.findIndex((stage) => stage.id === writerId);
  const writer = pipeline.stages[writerIndex];
  if (writer?.kind !== "behaviourReview") return undefined;
  for (const candidate of pipeline.stages.slice(writerIndex + 1)) {
    const gate = gateServedBy(pipeline, candidate.id);
    if (gate && delegatedAuthoring(pipeline, gate.id)?.writerStageId === writerId) {
      return candidate;
    }
  }
  return undefined;
}

/** What a checks stage is handed: the gate it serves and the items it must implement. */
export interface ChecklistToImplement {
  gate: TaskStage;
  items: ChecklistItem[];
}

/**
 * The items a checks stage must account for.
 *
 * Every item the gate answers for that is still open and asks something a check could
 * settle -- unticked, not withdrawn, not an `action`. An item already naming a check is
 * included and says so, because a re-run must be able to see that the existing check
 * covers it rather than writing a second; and one whose check failed is exactly the item
 * this stage most needs to look at.
 *
 * Absent wherever the gate has nothing written upstream, so a route that has not adopted
 * the three-stage shape sends the checks stage exactly the prompt it always did.
 */
export function checklistToImplement(
  pipeline: TaskPipeline,
  stageId: string,
): ChecklistToImplement | undefined {
  const gate = gateServedBy(pipeline, stageId);
  if (!gate || isResolved(gate)) return undefined;
  if (delegatedAuthoring(pipeline, gate.id)?.checksStageId !== stageId) return undefined;

  const items = coverageForGate(pipeline, gate.id)
    .map((entry) => entry.item)
    .filter((item) => !item.checked && !item.retired && (item.kind ?? "verify") === "verify");
  if (items.length === 0) return undefined;
  return { gate, items };
}

/** One line of a checks stage's account: the check that answers an item, or the gap. */
export interface ItemAccount {
  itemId: string;
  check?: string;
  gap?: string;
  line: string;
}

export const ITEM_MARKER = "ITEM";

/**
 * Every item account in a reply.
 *
 * `ITEM <id>: check <check id>` or `ITEM <id>: gap — <what is missing>`. Anchored on the
 * marker owning the start of its line, the rule every marker here follows, so the word
 * in prose is never read. The last account for an id wins: a stage that revises its own
 * answer after doing more work means the later line. A state that is neither word is not
 * an account -- it is dropped, and the item then reads as unaccounted, which holds.
 */
export function parseItemAccounts(reply: string): ItemAccount[] {
  const byId = new Map<string, ItemAccount>();
  const pattern = new RegExp(
    markerLine(`${ITEM_MARKER}[ \\t]+\`?([A-Za-z0-9._-]+)\`?[ \\t]*:`, "[ \\t]*(.*)$"),
    "gim",
  );
  // A list bullet stripped first: one account per item is a list, and a session writing
  // a list writes bullets. The shared lead-in does not admit one, because every other
  // marker is a single line; this one is many, and missing them all would hold the stage
  // on accounts it wrote exactly as asked -- the heading-hid-the-marker failure again.
  const unbulleted = reply.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1");
  for (const match of unbulleted.matchAll(pattern)) {
    const itemId = match[1];
    const rest = markerText(match[2], match[0]);
    const check = /^check\b[ \t]*[:—–-]?[ \t]*`?([A-Za-z0-9._-]+)`?/i.exec(rest);
    if (check) {
      byId.set(itemId, { itemId, check: check[1], line: match[0].trim() });
      continue;
    }
    const gap = /^gap\b[ \t]*[:—–-]?[ \t]*(.*)$/i.exec(rest);
    if (gap) {
      byId.set(itemId, { itemId, gap: gap[1].trim() || "no reason given", line: match[0].trim() });
    }
  }
  return [...byId.values()];
}

/** The outcome of applying a checks stage's accounts to the pipeline. */
export interface AppliedAccounts {
  pipeline: TaskPipeline;
  /** Items now naming the check the stage says answers them. */
  attached: ChecklistItem[];
  /** Items the stage named as a capability gap, with what it said is missing. */
  gaps: { item: ChecklistItem; reason: string }[];
  /** Accounts that answered nothing, with why -- announced, never dropped silently. */
  ignored: { line: string; why: "no such item" | "no such check" }[];
  /** Items handed to the stage that it said nothing about. */
  unaccounted: ChecklistItem[];
}

/**
 * Attaches the checks a stage says it wrote to the items they implement.
 *
 * Three guards:
 *
 * - **Only the items it was handed.** An id from another gate, or one made up, attaches
 *   to nothing; the stage was asked about a list and answers for that list.
 * - **The check must be in the manifest.** Tested as the quoted id appearing in the file,
 *   the least the harness can know without parsing a format that belongs to the
 *   project's tooling. An unreadable manifest is not a reason to refuse: a claim naming
 *   a check that does not exist holds the gate on its own account, which is the safe
 *   direction.
 * - **Never ticks.** Attaching and settling are two acts; whether the item is now
 *   answered is `tickAnsweredItems`' question, decided from the gate's run.
 *
 * Re-attribution is allowed, unlike a correction's coverage claim, because every item
 * here is unticked: no tick was ever granted on the id being replaced.
 */
export function applyItemAccounts(
  pipeline: TaskPipeline,
  items: readonly ChecklistItem[],
  accounts: readonly ItemAccount[],
  manifestText: string | undefined,
): AppliedAccounts {
  const handed = new Map(items.map((item) => [item.id.toLowerCase(), item]));
  const attached: ChecklistItem[] = [];
  const gaps: AppliedAccounts["gaps"] = [];
  const ignored: AppliedAccounts["ignored"] = [];
  const accounted = new Set<string>();

  for (const account of accounts) {
    const item = handed.get(account.itemId.toLowerCase());
    if (!item) {
      ignored.push({ line: account.line, why: "no such item" });
      continue;
    }
    if (account.check) {
      if (manifestText !== undefined && !manifestText.includes(`"${account.check}"`)) {
        ignored.push({ line: account.line, why: "no such check" });
        continue;
      }
      accounted.add(item.id);
      if (item.coveredBy !== account.check) {
        pipeline = setItemCoverage(pipeline, item.id, account.check);
      }
      attached.push({ ...item, coveredBy: account.check });
      continue;
    }
    accounted.add(item.id);
    gaps.push({ item, reason: account.gap ?? "no reason given" });
  }

  return {
    pipeline,
    attached,
    gaps,
    ignored,
    unaccounted: items.filter((item) => !accounted.has(item.id)),
  };
}

/** Why a checks stage is held when it left items unaccounted for. */
export function unaccountedItemsReason(unaccounted: readonly ChecklistItem[]): string {
  return (
    `This stage was handed ${unaccounted.length} checklist item(s) and said nothing about ` +
    `them: ${unaccounted.map((item) => item.id).join(", ")}. An item with no check and no ` +
    "stated gap is indistinguishable from one nobody looked at, and the gate after this " +
    "stage would then ask a person for it on every run.\n\n" +
    "Correct this stage naming the items: a correction keeps the checks already written " +
    "and may answer the rest. Approve it instead if they are genuinely gaps."
  );
}

/**
 * Tells a checks stage which items it implements, and how to account for each.
 *
 * The list is restated rather than left to the gate, for `planStepInstruction`'s reason:
 * the ids the stage must answer for are the ones the harness holds.
 */
export function itemAccountInstruction(toImplement: ChecklistToImplement): string {
  const lines = toImplement.items.map((item) => {
    const covered = item.coveredBy ? ` _(currently named as answered by \`${item.coveredBy}\`)_` : "";
    return `  - ${item.id}: ${item.text}${covered}`;
  });
  return `

## The checklist these checks implement

"${toImplement.gate.name}" will run your checks and tick each item whose check passes.
Its checklist was written before this stage, from the specification, and it is what you
are implementing -- not a starting point for a list of your own. Work through it in
order: for each item, write **one check that establishes the whole of what the item
says**, named after what the item asserts, and run it.

${lines.join("\n")}

Do not write a check no item names. If you find something the list should have said,
say so in your report; it is a finding about the checklist, not a check.

End your reply with one line per item, exactly in this form:

${ITEM_MARKER} <item id>: check <check id>
${ITEM_MARKER} <item id>: gap — <the step or capability the suite is missing>

Every id above must appear. "check" names a check that is in the manifest when you
finish, and that check must establish the whole item -- the gate ticks the item when it
passes. "gap" is a correct answer and is recorded as one: name what is missing precisely
enough that somebody could add it, since that is what turns the gap into work. An item
you do not mention holds this stage, because an item nobody accounted for is
indistinguishable from one nobody looked at.`;
}
