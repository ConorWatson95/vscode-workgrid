# task-workspaces

VS Code extension (`task-workspaces`, publisher-side name "Task Workspaces"). Each
**task** is an isolated development workspace backed by a git worktree + branch,
with a coding agent (Claude Code) attached. Activates on `workspaceContains:.git`;
contributes one tree view, `taskWorkspaces`.

## Commands

```
npm test          # vitest run — the one you want
npm run typecheck # tsc --noEmit
npm run build     # esbuild → dist/extension.js
npm run package   # vsce package
npx vitest run src/domain/pipelineEngine.test.ts   # single file
```

Run `npm test` and `npm run typecheck` before claiming work is done. `npm run build`
too if you touched `extension.ts` or anything it imports.

**`tsconfig.json` excludes `**/*.test.ts`**, so `typecheck` will pass while test
files are broken. `npm test` is the only thing that checks them — never treat a
clean typecheck as evidence the tests still compile.

## The testing rule that shapes everything

`vitest.config.ts` includes `src/**/*.test.ts`, and **those files never import
`vscode`**. There is no `vscode` mock. So:

> Anything worth testing gets extracted into a `vscode`-free module, and the file
> that imports `vscode` becomes a thin shell over it.

Examples: `storedStateMigration.ts` (pure) vs `extensionStateTaskRepository.ts`
(Memento shell); `reviewRulesFile.ts` (parsing) vs `reviewRulesService.ts` (fs);
`taskPhase.ts`/`statusPresentation.ts` (pure derivation) vs the tree provider.

If you find yourself unable to test something, that's the signal to split it, not
to skip the test.

## Layout

| Path | Role | Imports `vscode`? |
|---|---|---|
| `src/domain/` | Pure model + logic. Routes, pipeline engine, review rules. | Never |
| `src/git/` | Git process wrapper; parsers exported separately for tests. | No |
| `src/persistence/` | `TaskRepository` interface, in-memory impl, Memento impl. | Only the Memento impl |
| `src/services/` | Orchestration across git + persistence + domain. | Avoid |
| `src/agents/` | Claude Code CLI: stream-json parsing, sessions, transcripts, plan usage. | Some |
| `src/ui/` | Tree provider, webview panels, presentation helpers. | Yes |
| `src/commands/` | Command handlers; `CommandContext` carries all deps. | Yes |

## Conventions

- **`Result<T, E>`** (`src/utilities/result.ts`) for expected failures — git errors,
  validation, missing CLI. Exceptions are for programmer errors only.
- **Dependency injection over imports** in services, via narrow interfaces
  (`ChangedPathsSource`, `ReviewRulesReader`, `ServiceClock`). This is what keeps
  tests free of git and the filesystem.
- **Injected time.** Domain transitions take an `at: string` parameter; services
  take a `ServiceClock`. Nothing pure calls `Date.now()`.
- **Immutable domain transitions.** `pipelineEngine` functions return new state and
  never mutate their input; there's a test asserting it.
- **Comments explain why, not what.** Match the surrounding density.
- Two-space indent, double quotes, trailing commas. No linter configured.

## Invariants — breaking these loses user data

- **Do not bump `CURRENT_SCHEMA_VERSION`** (`storedStateMigration.ts`) without a
  real migration. Tasks hold the only copy of a worktree's friendly metadata, and
  worktrees with no matching task are reported as *orphans* — so discarding the
  blob turns a user's task list into a list of unadopted strangers. Migration
  quarantines unreadable data, never drops it.
- **Git is the source of truth** for worktree existence, branch, changed files and
  commits. Persisted tasks own only friendly metadata.
- **`worktreePath` is the reconciliation key** (`taskReconciliationService.ts`),
  normalised case-insensitively with forward slashes. A stored task whose worktree
  is gone is marked `failed`, never deleted.
- **Review rules load from the repository root, never a task worktree**, so a
  branch cannot relax the reviews it is subject to.

## The harness (in progress)

Layered on top of tasks: a **route** is a declared sequence of stages for a kind of
work; stages split into **subtasks** (units within the same worktree, each its own
agent session); a **rules engine** appends conditional reviews based on what the
diff touched; a **human-verification gate** refuses to pass while checklist items
are outstanding.

- `domain/taskRoute.ts` — route + stage definitions, `StageKind`, built-in routes.
- `domain/taskPipeline.ts` — live state; plain JSON, round-trips through the repo.
- `domain/pipelineEngine.ts` — pure transitions. `nextAction()` reports what to do
  next; callers report back what happened. The engine never runs anything.
- `domain/reviewRules.ts` — the matcher. **The extension ships no rules of its
  own** (`NO_REVIEW_RULES` is empty): which changes oblige which reviews is a
  property of a specific codebase, so a project with no rules file requires
  nothing. Never add domain rules here.
- `domain/reviewRuleTemplates.ts` — starter sets (`minimal`, `dotnet`) copied into
  a project by "Create Harness Config". Templates only; never applied implicitly.
- `domain/harnessConfigFile.ts` + `reviewRulesFile.ts` — parsing/validation of a
  project's `.taskworkspaces/harness.json` (`{ routes, rules }`), read from the
  **repository root**. `review-rules.json` is still read as a rules-only fallback.
- **Routes are project config too.** `BUILT_IN_ROUTES` is a *fallback* offered
  when a project defines none — unlike rules, which have no fallback. A project's
  routes replace the built-ins entirely, and every route must contain a stage with
  `gate: "approval"` or it is rejected, so no route can pass itself.
- `services/reviewPlanService.ts` — joins git changed paths + rules + engine.

- `services/pipelineRunner.ts` — the driver. Asks `nextAction`, does it, records
  the outcome, repeats; stops at human gates and failures. Depends on a narrow
  `StageSessionRunner`, so its tests need no agent.
- `agents/stagePrompts.ts` — prompts for splitting, running a subtask and
  producing a behaviour checklist, plus tolerant parsers. Every prompt assumes a
  session with **no prior context**, because that is what subtask-per-session
  gives it.
- `agents/stageSessionRunner.ts` — the real adapter over `AgentSessionManager`.
  `create()` stops any existing session, so each subtask starts empty.

### The permission gate

A headless stage has nobody to approve anything, so any call not covered by
`permissions.allow` is refused; the agent rewords it several times, works around
it, and the stage has to be re-run once a rule is added. The gate replaces that:
a `PreToolUse` command hook (`agents/permissionGateScript.ts`, shipped as a
string) parks the call in a per-task inbox and blocks; `PermissionGateService`
sweeps the inbox, applies `domain/permissionGatePolicy.ts`, and writes back
`allow`/`deny`. The agent then continues **mid-turn** — no re-run, and no rule
needed just to unblock.

Facts established by probing the CLI, so they are not re-derived:

- **`can_use_tool` is unreachable.** It is a real CLI→host control request, but
  it is only emitted down the CLI's own bridge channel. Advertising the
  capability over stdin changes nothing.
- **`PermissionRequest` hooks do not fire in print mode.** There is no prompt
  surface headlessly, so there is no request to hook — the call is just denied.
- **`permissionDecision: "ask"` becomes a denial.** It does not raise a prompt
  to the host either.
- So `PreToolUse` + `allow`/`deny` is the whole mechanism, and it fires for
  **every** tool call.
- **A hook may block for a long time.** Verified honoured to 282s with
  `timeout: 900`; the run then completed with `permission_denials: []`.

Two invariants follow from that last point, and both are load-bearing:

- **Emitting no stdout means "pass".** Any `permissionDecision` at all overrides
  the CLI's own classifier, so a pass spelled as `allow` would silently grant
  everything the gate declined to hold. The gate passes by default and holds only
  capabilities the CLI has *already* refused — which is why it does not need to
  replicate the CLI's idea of a safe command, and must not start.
- **Paths in the settings file must be absolute and the hook command quoted.**
  The CLI reads it with the *worktree* as cwd, so a relative path silently never
  fires, which looks exactly like the feature being off.

**Status:** wired end to end — route picker → stages in the tree → Advance Route
drives split/run/checklist → approve gate. Remaining gap: stage outcomes are
**self-reported**. `finishSubtask(..., "done")` records that the agent session
ended without error, not that the build or tests actually passed. A stage kind
whose outcome comes from a process exit code is the next real correctness step.

## Context discipline

Sessions here have historically ballooned to 500+ tool calls, dominated by `Edit`
churn and whole-file reads. Prefer targeted reads (`offset`/`limit`), fewer larger
edits, and `Explore`/subagents for broad sweeps so file dumps stay out of the main
context. Large logs or transcripts belong in a scratchpad file to be read in
slices, not pasted into the conversation.
