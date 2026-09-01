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
/**
 * A command that *uses* a document rather than merely fetching one.
 *
 * Deliberately a verb list and not "any command naming a file". Downloading five
 * attachments says nothing about which one governs the work, and recording all five is
 * how a reference list becomes noise nobody reads — the failure `taskReferences` is
 * careful to avoid by never scanning.
 */
const USES_DOCUMENT =
  /\b(unzip|expand-archive|openpyxl|pandas|read_excel|pdftotext|libreoffice|soffice|iconv|cat|type|Get-Content|python|node)\b/i;

/**
 * Strips what a shell puts around a path.
 *
 * The bare alternative below matches a token including its opening quote, because a
 * quote is not whitespace — so the extension read as `xlsx"` and every quoted workbook
 * was silently dropped. That was the whole bug on the first attempt at this fix, and it
 * only showed up when the real commands were replayed through it: the paths here are
 * routinely quoted precisely *because* they contain spaces.
 */
function unwrap(candidate: string): string {
  // Everything up to the *last* opening delimiter goes with it, not just a leading run
  // of them. The bare alternative matches a whole whitespace-delimited token, so a path
  // written inside a code string arrives as `openpyxl.load_workbook('Mock-up.xlsx` —
  // which passes the extension check, then dedupes against nothing, and lists one
  // workbook twice under two spellings.
  return candidate.replace(/^.*[('"`=[]/, "").replace(/['"`),;\]]+$/, "");
}

/** A quoted or bare path in a command. Quoted first: these paths contain spaces. */
const DOCUMENT_IN_COMMAND = /"([^"]+?\.[a-z0-9]{2,5})"|'([^']+?\.[a-z0-9]{2,5})'|(\S+\.[a-z0-9]{2,5})/gi;

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
 * ## Read from the commands, because a document is never opened with a file tool
 *
 * This was keyed on `pathsRead`, on the reasoning that a document is established as
 * relevant by having been *opened* rather than downloaded — a stage that fetched five
 * attachments and read one has said which mattered. Sound in principle and false in
 * fact: **a binary cannot be opened with the Read tool.** A workbook is unzipped, run
 * through a parser, or converted, and every one of those is a shell command.
 *
 * Measured across 17 pipelines, 1 Sep 2026: `pathsRead` holds **855 entries** — `sql`,
 * `md`, `cs`, `cshtml`, `ps1`, `png` — and **not one** is document-shaped, while **70
 * commands** name a workbook or an attachment. So the module had captured nothing since
 * it shipped, and the discriminator it chose could never have fired. A check that
 * silently does not fire is indistinguishable from the feature being absent, which is
 * the failure the unquoted hook command already taught this codebase.
 *
 * The cost was real: a report's layout came from tab 3 of a wireframe nobody was
 * pointed at, and `rc-plan` and `rc-implement-sql` were each corrected for it
 * separately — the rediscovery-per-stage this exists to end.
 *
 * ## The fetched-versus-read distinction is kept, by a different means
 *
 * Dropping it would record every attachment a stage downloaded and never looked at,
 * which is how a reference list stops being read. So a path counts only when a command
 * *does something* with it: unzips it, parses it, converts it, reads it. A command whose
 * only verb is a download does not qualify, and the ticket key is still taken from
 * whichever command fetched it.
 */
export function discoveredDocuments(activity: {
  pathsRead?: readonly string[];
  commands?: readonly string[];
}): DiscoveredDocument[] {
  const commands = activity.commands ?? [];
  const ticket = commands
    .map((command) => ATTACHMENT_COMMAND.exec(command)?.[1])
    .find((key): key is string => !!key);

  // `pathsRead` first, so a document a file tool *did* manage to open still wins its
  // place — a `.csv` or a `.txt` export is readable, and nothing here should get worse
  // for the formats that already worked.
  const candidates = [...(activity.pathsRead ?? [])];
  for (const command of commands) {
    if (!USES_DOCUMENT.test(command)) continue;
    for (const match of command.matchAll(DOCUMENT_IN_COMMAND)) {
      candidates.push(unwrap(match[1] ?? match[2] ?? match[0]));
    }
  }

  const seen = new Set<string>();
  const found: DiscoveredDocument[] = [];
  for (const raw of candidates) {
    const path = normalise(raw);
    if (!DOCUMENT_EXTENSIONS.has(extensionOf(path))) continue;
    // A glob is a search, not a document. `find -iname "*purchases*sales*.xlsx"` names
    // the shape of a file somebody was looking for, and recording it as a reference
    // states to every later stage that a pattern governs the work.
    if (/[*?]/.test(path)) continue;
    const lower = `/${path.toLowerCase()}`;
    if (NOISE.some((fragment) => lower.includes(fragment))) continue;
    // Keyed on the file name, not the path. One workbook is reached as an absolute
    // path, as `../name.xlsx` from a scratch directory, and as a bare name after a
    // `cd` -- three spellings of one document, and listing it three times is the noise
    // that stops a reference list being read. The first spelling wins, and `pathsRead`
    // is scanned first precisely so a real opened path outranks a fragment of a shell
    // line. Deliberately looser than comparing whole paths, for the reason
    // `claimEvidence` matches on the last segment: a document spelled differently by
    // two stages is one document.
    const key = (path.split("/").pop() ?? path).toLowerCase();
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
