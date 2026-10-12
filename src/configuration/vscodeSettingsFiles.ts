import * as path from "node:path";

/**
 * Reads this extension's settings out of VS Code's own settings files, for a process
 * VS Code did not start.
 *
 * A headless runner has to drive a stage exactly as the extension would — same model,
 * same timeouts, same MCP servers — and the settings that decide that are VS Code
 * settings. Reading the files keeps one source of truth: a second copy in
 * `harness.json` would be a second place to edit, and the first edit made in only one
 * of them would make a headless stage and an in-window stage of the same route behave
 * differently with nothing on screen to say why.
 *
 * Two files, in VS Code's own precedence: user settings, then the repository's
 * `.vscode/settings.json` over them. Not read, and said so by `sources`: settings in a
 * non-default profile, in a `.code-workspace` file, or language-scoped. Each is a place
 * VS Code would look and this does not, which is why the files actually read are
 * reported rather than assumed.
 */

export const SETTINGS_SECTION = "taskWorkspaces";

export interface SettingsFileRead {
  /** Setting values keyed without the section prefix, as `HarnessSettings` reads them. */
  values: Record<string, unknown>;
  /** The files that existed and parsed, lowest precedence first. */
  sources: string[];
  /** Files that existed and could not be parsed. Their settings are not applied. */
  problems: string[];
}

/**
 * VS Code's user settings file for each install this machine might have, stable first.
 * Only the first that exists is used: two installs are two people's worth of settings,
 * and merging them would produce a configuration neither of them chose.
 */
export function userSettingsCandidates(env: {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
}): string[] {
  const base =
    env.platform === "win32"
      ? env.appData ?? path.join(env.home, "AppData", "Roaming")
      : env.platform === "darwin"
        ? path.join(env.home, "Library", "Application Support")
        : path.join(env.home, ".config");
  return ["Code", "Code - Insiders"].map((product) =>
    path.join(base, product, "User", "settings.json"),
  );
}

export function workspaceSettingsPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".vscode", "settings.json");
}

/**
 * Reads and merges the settings, workspace over user.
 *
 * `read` returns undefined for a file that does not exist, so a missing file is
 * silence and an unreadable one is a problem: settings quietly not applied are exactly
 * the divergence this module exists to prevent.
 */
export function readSettingsFiles(
  userCandidates: readonly string[],
  workspaceFile: string,
  read: (file: string) => string | undefined,
): SettingsFileRead {
  const result: SettingsFileRead = { values: {}, sources: [], problems: [] };
  const apply = (file: string): boolean => {
    const text = read(file);
    if (text === undefined) return false;
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch (error) {
      result.problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
    Object.assign(result.values, sectionValues(parsed));
    result.sources.push(file);
    return true;
  };
  for (const candidate of userCandidates) {
    if (apply(candidate)) break;
  }
  apply(workspaceFile);
  return result;
}

/**
 * This extension's keys from a parsed settings object, prefix removed.
 *
 * VS Code writes them flat (`"taskWorkspaces.model": "sonnet"`), and accepts a nested
 * object too; both are read, flat winning, which is the order VS Code resolves them in.
 */
export function sectionValues(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const values: Record<string, unknown> = {};
  const record = parsed as Record<string, unknown>;
  const nested = record[SETTINGS_SECTION];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    Object.assign(values, nested);
  }
  const prefix = `${SETTINGS_SECTION}.`;
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith(prefix)) values[key.slice(prefix.length)] = value;
  }
  return values;
}

/**
 * Parses VS Code's JSON-with-comments: line and block comments and trailing commas,
 * none of which `JSON.parse` accepts and all of which a hand-edited settings file has.
 *
 * Stripped by a scan that tracks string literals, because a URL in a setting value
 * (`"https://…"`) contains `//` and a regex would cut it in half.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out += text.slice(start, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Trailing commas, now that no comment can sit between the comma and the bracket.
  // Strings are re-protected by matching them first and leaving them untouched.
  const cleaned = out.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (match, closer) =>
    closer === undefined ? match : closer,
  );
  return cleaned.trim() === "" ? {} : JSON.parse(cleaned);
}
