/**
 * Masks credentials in anything the harness keeps or shows.
 *
 * Necessary because of how much the harness now records. A stage's commands are
 * kept **verbatim** — deliberately, since seeing the wrong flag is the point — and
 * its output is kept too, and both are written into the task state file, which
 * lives on disk and is read and rewritten whole. A route that builds a connection
 * string from a profile and passes it to a deployment script therefore wrote a
 * live password to disk and rendered it in a report.
 *
 * Applied at capture *and* at render: at capture so nothing secret reaches the
 * state file, and at render so material already recorded by an earlier build is
 * masked when it is read back.
 *
 * Pure, so the patterns are unit-tested. They have to be: a redactor that quietly
 * stops matching is worse than none, because the output looks safe either way.
 *
 * Deliberately errs towards over-masking. A masked value that turned out to be
 * harmless costs a reader one glance at the terminal; an unmasked one that turned
 * out to be a live password cannot be taken back.
 */

export const REDACTED = "***REDACTED***";

/**
 * Assignment-style secrets: `Password=x`, `--api-key x`, `ConnectionString: y`.
 *
 * The value runs to the first delimiter that could not be part of it. `;` is
 * included because connection strings are the main case here, which also means a
 * password containing `;` is masked only up to it — acceptable, since the
 * remainder alone is not the credential.
 */
const ASSIGNED_SECRET =
  /((?:password|passwd|pwd|secret|token|api[-_ ]?key|access[-_ ]?key|auth|credential|connection[-_ ]?string|sas|pat)[a-z_-]*)(\s*[:=]\s*|\s+)(?!\s)("[^"]*"|'[^']*'|[^\s;,&"']+)/gi;

/** `-Password value`, `--password=value`, `/P:value` — the flag forms. */
const FLAG_SECRET =
  /((?:^|\s)(?:-{1,2}|\/)(?:password|passwd|pwd|secret|token|api[-_ ]?key|credential|sas|pat)[a-z_-]*(?:\s*[:=]\s*|\s+))(?!\s)("[^"]*"|'[^']*'|[^\s;,&"']+)/gi;

/** Credentials embedded in a URL: `scheme://user:secret@host`. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

/**
 * Tokens recognisable by shape alone, whatever they are called.
 *
 * Worth having because the assignment patterns only fire when something is
 * *named* like a secret, and a token pasted into a command or echoed by a tool
 * often is not.
 */
const SHAPED_TOKENS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/**
 * Command-line tools that take a password as a *single-letter* flag.
 *
 * These need their own pass, and it is the case that actually leaked: `sqlcmd -S
 * host -U sa -P Hunter2` contains no word resembling "password", so neither the
 * named patterns nor the cheap hint below saw anything at all. Scoped to lines
 * naming one of these tools, because `-p` means a port or a path far more often
 * than it means a password.
 */
const CREDENTIAL_TOOL =
  /\b(?:sqlcmd|osql|bcp|sqlpackage|mysql|mysqldump|mysqladmin|mongosh|mongodump|redis-cli|psql|curl|wget|smbclient|az|aws|gh)\b/i;

/** `-P secret`, `-P:secret`. Deliberately not `-U`, which is a user name. */
const SHORT_FLAG_SECRET =
  /((?:^|\s)-{1,2}[Pp](?:assword)?(?:\s*[:=]\s*|\s+))(?!-)("[^"]*"|'[^']*'|[^\s;,&"']+)/g;

/** mysql's attached form, `-pHunter2`, which has no separator at all. */
const ATTACHED_FLAG_SECRET = /((?:^|\s)-p)(?=[^\s-])([^\s;,&"']+)/g;

/** `curl -u user:secret` — here the value carries both, so all of it goes. */
const CURL_USERPASS = /((?:^|\s)-{1,2}u(?:ser)?(?:\s*[:=]\s*|\s+))(?!-)([^\s;,&"']+)/g;

/** Whether a line names a secret at all, for the cheap early exit. */
const CHEAP_HINT =
  /password|passwd|pwd|secret|token|api[-_ ]?key|access[-_ ]?key|credential|connection[-_ ]?string|bearer|:\/\/[^/\s]*:[^/\s]*@|gh[pousr]_|xox[baprs]-|sk-|AKIA|\bey[A-Za-z0-9_-]{10,}\.|\b(?:sqlcmd|osql|bcp|sqlpackage|mysql|mysqldump|mysqladmin|mongosh|mongodump|redis-cli|psql|curl|wget|smbclient)\b/i;

/**
 * Masks single-letter credential flags, line by line.
 *
 * Per line rather than over the whole text because the tool name and its flags
 * are on one line, and applying the rule to a document because some other line
 * mentioned `curl` would mask ports and paths everywhere.
 */
function redactShortFlags(text: string): string {
  if (!text.includes("-")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!CREDENTIAL_TOOL.test(line)) return line;
      let out = line.replace(SHORT_FLAG_SECRET, (_all, lead) => `${lead}${REDACTED}`);
      out = out.replace(ATTACHED_FLAG_SECRET, (_all, flag) => `${flag}${REDACTED}`);
      if (/\bcurl\b|\bwget\b/i.test(line)) {
        out = out.replace(CURL_USERPASS, (_all, lead) => `${lead}${REDACTED}`);
      }
      return out;
    })
    .join("\n");
}

/** Masks every credential this can recognise. Safe to call on anything. */
export function redactSecrets(text: string): string {
  if (!text || !CHEAP_HINT.test(text)) return text;

  // Shape first, because it is the most specific and the name-based patterns can
  // otherwise consume the wrong span: "Authorization: Bearer <token>" matches the
  // assignment pattern, whose value is then the word "Bearer" — masking that and
  // leaving the token. Replacing by shape is idempotent under the later passes.
  let result = text;
  for (const pattern of SHAPED_TOKENS) result = result.replace(pattern, REDACTED);

  result = result.replace(URL_USERINFO, (_all, scheme, user) => `${scheme}${user}:${REDACTED}@`);
  // Flags before assignments: `--password=x` matches both, and the flag form
  // keeps the flag itself intact, which is what makes the masked line readable.
  result = result.replace(FLAG_SECRET, (_all, lead) => `${lead}${REDACTED}`);
  result = result.replace(
    ASSIGNED_SECRET,
    (_all, name, separator) => `${name}${separator}${REDACTED}`,
  );
  return redactShortFlags(result);
}

/** Masks every string in a list, preserving order. */
export function redactAll(values: readonly string[]): string[] {
  return values.map((value) => redactSecrets(value));
}

/** True when redaction changed anything, so a reader can be told it happened. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
