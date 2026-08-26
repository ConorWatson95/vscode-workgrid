/**
 * Documents a stage went and found, so the next stage does not have to.
 *
 * Measured on NMGB-2814, 26 Aug 2026. `rc-plan` was given no references and did
 * the right thing entirely on its own: read the ticket over MCP, ran the
 * repository's own `tools/jira/Get-JiraAttachment.ps1 -Download`, unzipped the
 * resulting workbook, wrote a Python xlsx dumper because none existed, pulled the
 * pyramid box labels out of `xl/drawings/drawing3.xml` by regex, and read four
 * mock-up PNGs. Twenty-two of its fifty-four commands were spent getting hold of
 * documents.
 *
 * None of that survived the session. `TaskWorkspace.references` was empty, so the
 * eight stages behind it were told about no documents at all — and each was a cold
 * session facing the same twenty-two commands, or, far more often, not bothering
 * and using a neighbouring feature as the template instead. That is precisely the
 * failure `taskReferences` was built to prevent, arriving through the one door it
 * left open: the operator had not named the document, and the stage that found it
 * had nowhere to put it.
 *
 * Recording it passes `StageContext`'s test exactly — *eliminate deterministic
 * facts that are expensive or risky to rediscover*. Where the attachment landed on
 * disk is deterministic, was expensive to establish once, and no cold session can
 * derive it.
 *
 * ## Two tiers, because authority is not the same as availability
 *
 * `taskReferences` says references are "deliberately not discovered by scanning the
 * repository for likely-looking documents", because a guessed reference is stated
 * to every stage with the authority of one the operator chose. That rule stands and
 * this does not break it, for two reasons: nothing here scans — every path is one a
 * stage actually opened — and a discovered entry is marked, so `referenceGuidance`
 * can say a stage found it rather than that the operator says it governs.
 *
 * An operator entry is never replaced by a discovered one. The operator's note is
 * the part that carries the real information ("tab 3 of the wireframe"), and
 * overwriting it with a bare path would lose the only thing a discovered entry
 * cannot supply.
 *
 * ## Why extensions rather than location
 *
 * The attachments landed in the *main repository root* (`C:/Dev/qubeautoapp/
 * image-20260818-120002.png`), not the worktree and not a documents folder — so any
 * rule keyed on where a file sits would have missed every one of them. No source
 * file in this codebase carries these extensions, which makes the extension the
 * only stable signal. Noise directories are then excluded, because a stage doing
 * CSS work legitimately opens images that govern nothing.
 *
 * Pure and vscode-free.
 */

/**
 * Extensions that are a document rather than code.
 *
 * Deliberately excludes `.md` and `.json`: a repository is full of both, stages
 * read them constantly, and a governing document that happens to be markdown is
 * one the operator can name in a sentence. Including them would make every stage
 * contribute a dozen entries, and a reference list nobody trusts is one nobody
 * reads — the same failure an untrustworthy orphan list produces.
 */
const DOCUMENT_EXTENSIONS = new Set([
  "xlsx", "xlsm", "xls", "csv",
  "docx", "doc", "rtf", "odt",
  "pptx", "ppt",
  "pdf",
  "msg", "eml",
  "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp",
]);

/**
 * Path fragments that mean a file is part of the build or the product, not a
 * specification.
 *
 * A stage implementing a page reads the site's own images and stylesheet assets; a
 * stage that builds reads whatever lands in `bin`. Neither governs anything, and
 * both would appear on every task.
 */
const NOISE = [
  "/bin/", "/obj/", "/node_modules/", "/packages/", "/.git/", "/.vs/",
  "/assets/", "/content/", "/images/", "/img/", "/fonts/", "/scripts/",
  "/app_data/", "/testresults/", "/dist/", "/coverage/",
];

/** At most this many from one stage, so a stage that reads a folder of images cannot flood the list. */
const MAX_PER_STAGE = 6;

/** Where a discovered document came from, for the line a stage is shown. */
export interface DiscoveredDocument {
  /** Absolute or repo-relative path, exactly as the stage recorded reading it. */
  path: string;
  /** The ticket it was fetched for, when a command in the same session says so. */
  ticket?: string;
}

/** Matches the ticket key on an attachment-fetching command, so the note can say where it came from. */
const ATTACHMENT_COMMAND = /-IssueKey\s+["']?([A-Z][A-Z0-9]+-\d+)/;

function normalise(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

function extensionOf(path: string): string {
  const name = normalise(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Picks the documents worth remembering out of one subtask's activity.
 *
 * Read from `pathsRead` rather than from the commands, because a document is
 * established as relevant by having been *opened*, not by having been downloaded —
 * a stage that fetched five attachments and read one has told us which one mattered.
 * The commands are consulted only for the ticket key, which makes the note useful.
 */
export function discoveredDocuments(activity: {
  pathsRead?: readonly string[];
  commands?: readonly string[];
}): DiscoveredDocument[] {
  const ticket = (activity.commands ?? [])
    .map((command) => ATTACHMENT_COMMAND.exec(command)?.[1])
    .find((key): key is string => !!key);

  const seen = new Set<string>();
  const found: DiscoveredDocument[] = [];
  for (const raw of activity.pathsRead ?? []) {
    const path = normalise(raw);
    if (!DOCUMENT_EXTENSIONS.has(extensionOf(path))) continue;
    const lower = `/${path.toLowerCase()}`;
    if (NOISE.some((fragment) => lower.includes(fragment))) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path, ...(ticket ? { ticket } : {}) });
    if (found.length >= MAX_PER_STAGE) break;
  }
  return found;
}

/**
 * The note put on a discovered entry.
 *
 * Says how it got here and nothing about what it means. A discovered entry has no
 * claim to make about which part applies — that is the operator's `note`, and
 * inventing one would be the guess this module is careful not to make.
 */
export function discoveredNote(document: DiscoveredDocument, stageName: string): string {
  return document.ticket
    ? `${document.ticket} attachment, read by "${stageName}"`
    : `read by "${stageName}"`;
}
