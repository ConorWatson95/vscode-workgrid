import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the boundary the headless harness depends on.
 *
 * The rule this enforces: from each root below, no chain of relative imports
 * reaches `vscode`. That is what lets a route run with no editor attached, and
 * it is easy to break by accident — one convenience import in a shared module
 * taints every module above it, and `tsconfig.json` excludes test files so
 * `typecheck` would stay green while the tests stopped compiling.
 *
 * Static analysis rather than importing the modules: this must fail with the
 * offending chain named, not with a resolution error from `vscode` itself.
 */

/** Entry points a headless run has to be able to construct. */
const HEADLESS_ROOTS = [
  "src/services/pipelineRunner.ts",
  "src/services/taskWorkspaceService.ts",
  "src/services/reviewPlanService.ts",
  "src/services/taskReconciliationService.ts",
  "src/services/permissionGateService.ts",
  "src/persistence/taskStateStore.ts",
  "src/persistence/fileTaskRepository.ts",
  "src/persistence/nodeStateFileIo.ts",
  "src/configuration/harnessSettings.ts",
  "src/logging/logger.ts",
  // The route-execution path: splitting a stage, running a subtask, and the
  // permission gate that keeps a headless stage from stalling on a refusal.
  "src/agents/stageSessionRunner.ts",
  "src/agents/agentSessionManager.ts",
  "src/agents/claudeStreamSession.ts",
  "src/agents/stagePrompts.ts",
  "src/agents/permissionGateScript.ts",
  "src/git/gitWorktreeService.ts",
  "src/domain/pipelineEngine.ts",
  "src/domain/taskRoute.ts",
  "src/domain/reviewRules.ts",
  "src/domain/harnessConfigFile.ts",
];

function resolveImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.join(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate.split(path.sep).join("/");
  }
  return undefined;
}

function importSpecifiers(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  return [
    ...[...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]),
  ];
}

/** Import chains from `entry` that end at `vscode`, deepest detail first. */
function chainsToVscode(entry: string): string[] {
  const visited = new Set<string>();
  const offenders: string[] = [];
  const stack: Array<{ file: string; trail: string[] }> = [
    { file: entry, trail: [entry] },
  ];

  while (stack.length > 0) {
    const { file, trail } = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of importSpecifiers(file)) {
      if (specifier === "vscode") {
        offenders.push([...trail, "vscode"].join("\n  -> "));
        continue;
      }
      const next = resolveImport(file, specifier);
      if (next) stack.push({ file: next, trail: [...trail, next] });
    }
  }

  return offenders;
}

describe("headless boundary", () => {
  it.each(HEADLESS_ROOTS)("%s does not reach vscode", (root) => {
    expect(fs.existsSync(root), `${root} does not exist`).toBe(true);
    expect(chainsToVscode(root)).toEqual([]);
  });

  it("detects a chain that does reach vscode, so the guard cannot pass vacuously", () => {
    // The extension entry point must fail this, or the analysis is not working.
    expect(chainsToVscode("src/extension.ts").length).toBeGreaterThan(0);
  });
});
