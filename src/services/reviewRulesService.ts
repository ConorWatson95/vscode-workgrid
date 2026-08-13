import * as fs from "node:fs";
import * as path from "node:path";
import { ReviewRule } from "../domain/reviewRules";
import { REVIEW_RULES_RELATIVE_PATH } from "../domain/reviewRulesFile";
import { parseHarnessConfig } from "../domain/harnessConfigFile";
import { BUILT_IN_ROUTES, RouteDefinition } from "../domain/taskRoute";
import { SuggestionSource } from "../domain/suggestionSourceFile";

/**
 * Loads a project's review rules from disk.
 *
 * Rules are read from the **repository root**, not from the task's worktree.
 * That is deliberate: if a task branch supplied its own rules, a change could
 * relax the verification it is subject to, which defeats the point of encoding
 * the requirements. Adding or loosening a rule therefore has to land on the base
 * branch, where it gets reviewed like any other change.
 */

/** Conventional harness config, holding both routes and rules. */
export const HARNESS_CONFIG_RELATIVE_PATH = ".taskworkspaces/harness.json";

export interface LoadedHarness extends LoadedReviewRules {
  /** Routes offered for this project: its own, or the built-ins. */
  routes: RouteDefinition[];
  /** True when the project defined no routes, so the built-ins are offered. */
  usingBuiltInRoutes: boolean;
  /**
   * Where this project keeps work worth suggesting.
   *
   * No fallback, unlike routes: a route is process scaffolding and a default is better
   * than an empty picker, whereas a *source* is somebody's ticket board. Guessing at one
   * would be the extension inventing where a team's work lives.
   */
  suggestionSources: SuggestionSource[];
}

export interface LoadedReviewRules {
  rules: ReviewRule[];
  /** Absolute path read, or undefined when no project file exists. */
  sourcePath?: string;
  /** Validation failures worth surfacing to the user. */
  problems: string[];
  /**
   * True when no usable project rules were loaded, so no reviews are required.
   * The extension contributes none of its own, making this a real "nothing is
   * configured" answer rather than a fallback to someone else's assumptions.
   */
  noRulesConfigured: boolean;
}

export interface ReviewRulesReader {
  readFile(filePath: string): string | undefined;
}

/** Default reader; returns undefined for any unreadable path. */
export const fsReader: ReviewRulesReader = {
  readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * Resolves a repository's harness config: the routes it offers and the review
 * rules it enforces.
 *
 * Looks for the configured path if one is set, then `harness.json`, then the
 * older rules-only `review-rules.json`. Routes fall back to the built-ins when
 * the project defines none — a route is process scaffolding, and an empty picker
 * would make the feature invisible on day one. Rules have no such fallback,
 * because guessing which reviews a codebase owes is exactly what must not happen.
 */
export function loadHarness(
  repositoryRoot: string,
  options: {
    configuredPath?: string;
    reader?: ReviewRulesReader;
  } = {},
): LoadedHarness {
  const reader = options.reader ?? fsReader;
  const candidates = options.configuredPath?.trim()
    ? [options.configuredPath.trim()]
    : [HARNESS_CONFIG_RELATIVE_PATH, REVIEW_RULES_RELATIVE_PATH];

  for (const relative of candidates) {
    const sourcePath = path.isAbsolute(relative)
      ? relative
      : path.join(repositoryRoot, relative);
    const contents = reader.readFile(sourcePath);
    if (contents === undefined) continue;

    return parseHarnessContents(contents, sourcePath);
  }

  // No config at all: built-in routes, no rules, no suggestion sources.
  return {
    routes: [...BUILT_IN_ROUTES],
    suggestionSources: [],
    usingBuiltInRoutes: true,
    rules: [],
    problems: [],
    noRulesConfigured: true,
  };
}

function parseHarnessContents(
  contents: string,
  sourcePath: string,
): LoadedHarness {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(contents));
  } catch (error) {
    // The project has a config it cannot read. Requiring no reviews silently
    // would read as a clean bill of health, so complain loudly instead.
    return {
      routes: [...BUILT_IN_ROUTES],
      usingBuiltInRoutes: true,
      rules: [],
      // An unreadable config is not a project without sources; scanning is simply
      // unavailable until it parses, which the problem list says out loud.
      suggestionSources: [],
      sourcePath,
      problems: [
        `${sourcePath} is not valid JSON (${(error as Error).message}). ` +
          "No review rules are being applied until it is fixed.",
      ],
      noRulesConfigured: true,
    };
  }

  const parsed = parseHarnessConfig(raw);
  return {
    routes: parsed.routes.length > 0 ? parsed.routes : [...BUILT_IN_ROUTES],
    usingBuiltInRoutes: parsed.routes.length === 0,
    rules: parsed.rules,
    suggestionSources: parsed.suggestions,
    sourcePath,
    problems: parsed.problems,
    noRulesConfigured: parsed.rules.length === 0,
  };
}

/**
 * Rules-only view, for callers that do not care about routes. Delegates so the
 * file search order and the failure behaviour have one definition.
 */
export function loadReviewRules(
  repositoryRoot: string,
  options: {
    configuredPath?: string;
    reader?: ReviewRulesReader;
  } = {},
): LoadedReviewRules {
  const {
    routes: _routes,
    usingBuiltInRoutes: _builtIn,
    suggestionSources: _sources,
    ...rules
  } = loadHarness(repositoryRoot, options);
  return rules;
}

/**
 * Strips `//` and block comments so a rules file can be annotated. Rules encode
 * team reasoning, and the reason a rule exists is worth writing down next to it.
 * String contents are preserved, since patterns contain slashes.
 */
export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    output += char;
  }

  return output;
}
