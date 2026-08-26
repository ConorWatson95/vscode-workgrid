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
`taskPhase.ts`/`statusPresentation.ts` (pure derivation) vs the tree provider;
`harnessSettings.ts` (defaults + normalisation) vs `extensionConfiguration.ts`
(scoping + the two writers); `logger.ts` (interface only) vs
`outputChannelLogger.ts`.

If you find yourself unable to test something, that's the signal to split it, not
to skip the test.

**`headlessBoundary.test.ts` enforces this.** It statically walks relative
imports from every module a headless run must construct — services, persistence,
settings, git, and the whole route-execution path in `agents/` — and fails with
the offending chain if any reaches `vscode`. One convenience import in a shared
module taints everything above it, so add new headless entry points to its root
list rather than discovering the breakage later.

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
- **Never round-trip a source file through PowerShell to edit it.** `Get-Content -Raw`
  in Windows PowerShell 5.1 decodes with the system ANSI codepage unless the file has a
  BOM, and no JSON or TypeScript file here has one — so reading and rewriting
  double-encodes every non-ASCII character: `—` becomes `â€”`, `…` becomes `â€¦`. It cost
  a released build. A one-line version bump done that way silently corrupted 34
  characters across 28 lines of `package.json`, and every command title containing an
  ellipsis shipped as mojibake in the VS Code menu. Use the editing tools, which preserve
  encoding; the tell that it has happened is a diff far larger than the edit.

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
- **Task state lives under the repository's git common dir**
  (`<git dir>/task-workspaces/state.json`, `taskStateFile.ts`), never in a
  working tree. Two reasons, both load-bearing: the rules engine keys reviews off
  git's changed paths, so state inside a worktree could oblige a review by being
  written; and a linked worktree's common dir is the main repo's, so every
  worktree shares one store. Resolve it with `--git-common-dir`, never by joining
  `.git` — that is a file in a linked worktree.
- **`normalizePipeline` must spread, never re-list fields.** It runs on every read of the
  state file, so a field it forgets is dropped on the next load — which is how `verify`,
  `verdict`, `blocked` and the whole `deferrals` list came to vanish on a window reload,
  turning each hold into one a reload switched off.
- **Writes to the state file are read-modify-write, atomically renamed**
  (`nodeStateFileIo.ts`). The extension and a headless run both write it, so a
  cached view or an in-place write would lose or truncate tasks.
- **The Memento is now a backup, not the source of truth.** `TaskStateStore`
  adopts its tasks into a repo's state file once, lazily, then never writes it
  again — adoption is per-repo because the Memento is global and other clones may
  not be mounted. Presence of the state file is the "already adopted" marker, so
  re-seeding cannot resurrect deleted tasks.
- **Review rules load from the repository root, never a task worktree**, so a
  branch cannot relax the reviews it is subject to.

## The harness (in progress)

Layered on top of tasks: a **route** is a declared sequence of stages for a kind of
work; stages split into **subtasks** (units within the same worktree, each its own
agent session); a **rules engine** appends conditional reviews based on what the
diff touched; a **human-verification gate** refuses to pass while checklist items
are outstanding.

**What the harness is for.** It owns workflow, routing, stage lifecycle, evidence,
approvals, durable task state, engineering policy, repository knowledge and stage
environments. Execution engines own *reasoning*. How a stage executes — single-shot,
a bounded loop, a graph, several agents, a deterministic process, a human — is an
implementation detail the harness must not care about; it cares about the engineering
outcome and the evidence for it. Keep it an engineering-harness runtime, not a Claude
wrapper, not a workflow engine, not an agent framework.

**The heuristic for what to add:** *the harness should eliminate high-confidence
engineering uncertainty, not low-cost exploration.* Eliminate deterministic facts that
are expensive or risky to rediscover — current work item, branch, worktree, stage,
evidence requirements, deployment target, durable repository documentation. But when a
fact is cheap for the model to discover and would cost real backend work to supply —
forcing a specific MCP tool, pre-computing every capability — let Claude discover it.
This is a build-cost trade, not a reason to tolerate slow stages: **stage startup
latency stays a top optimisation target**, and anything that cuts it cheaply is still
worth doing. Complexity is a cost and tokens are a cost; optimise the larger one. So
`StageContext`
is *the minimum set of verified engineering facts required to execute a stage*, not
everything the model might want to know.

**Skills are where execution protocol belongs — and a skill is per *engine*, not per
project.** The runtime has two interfaces, not one: harness → engine is `StageContext`
(verified engineering facts), engine → harness is the reply contract (`VERDICT`,
`DEFERRED`, `HANDOFF`, `STEP <n>`, `NEEDS-INFO`). A skill is the adapter that teaches
one execution engine to speak that contract, which is what makes adding a second engine
a new skill rather than a change to the harness. It also explains why some prompt text
resisted every attempt to move it into `StageContext`: it was never engineering
bootstrapping, it was the protocol between engine and harness, and it had no home.

How to interact with the runtime —
asking via `ask_user` versus `NEEDS-INFO`, writing a handoff worth carrying, declining
work as `DEFERRED`, accounting for plan steps, what a gate expects — is invariant
across every task and every project, which is exactly the shape of a skill. Packaging
it that way makes the protocol one versioned artifact instead of prose reassembled per
stage, and lets a stage pull in only the protocol it actually uses. Skills must hold
*protocol only*: project engineering knowledge belongs in `StageContext` and repository
docs, or the harness stops being generic.

Three layers, and the reason each sits where it does:

- **Contract** — declared by the *adapter's* invariant preamble, because determinism
  depends on it. `VERDICT`, `DEFERRED`, `HANDOFF`, `STEP <n>` must be stated in text
  that is always present; a skill the model chooses not to load yields a reply parsing
  as silence, which for deferrals and plan steps is precisely the failure those markers
  exist to catch. Being invariant is also what keeps it in the cached prefix.
- **Understanding** — taught by the skill, because it is engine-specific behavioural
  guidance: when to ask rather than assume, `ask_user` versus `NEEDS-INFO`, what makes
  a handoff worth carrying, how specific a checklist item must be.
- **Correctness** — enforced by the parser, because the runtime owns orchestration.
  Never trust the reply to be well-formed; `pipelineEngine`/`planSteps` decide what
  actually happened.

Note where the line falls: preamble *and* skill both belong to the engine adapter —
only the parser is the harness's. Swapping in another engine replaces the first two and
touches nothing else.

**Built 7 Aug 2026.** `agents/protocolSkill.ts` (content, shipped as a string like the
gate hook), `services/protocolSkillInstaller.ts` (writes it, overwrite-only),
`--plugin-dir` in `claudeCliArgs.ts`, installed once per resolved repository in
`extension.ts` and passed to **stage sessions only** — a hand-driven chat is not a
stage. What moved out of `preamble()`: how to ask well, what makes a handoff worth
carrying, how specific a checklist item must be, shell-versus-file-tool cost. What
stayed: every parsed marker, and re-run awareness — its failure is silent *and*
expensive, so it must hold whether the skill loads or not. The preamble names the skill
and says to read it, because loading is the model's choice and a skill nobody mentions
loads only sometimes. Verified end to end against CLI 2.1.223: a session given the real
plugin directory quoted the ask/NEEDS-INFO trade-off and the plan-step rule back.

**Where the skill lives — probed 7 Aug 2026, CLI 2.1.223.** A skills directory *can* be
sourced from outside the worktree, via `--plugin-dir <abs path>` pointing at a directory
holding `.claude-plugin/plugin.json` and `skills/<name>/SKILL.md`. Verified both ways
from an unrelated cwd: with the flag the skill loads, without it the CLI reports no such
skill. So the protocol skill goes under the **git common dir** beside `state.json` —
harness-owned, one copy per repository shared by every worktree, and a branch cannot
edit the protocol it is subject to. It follows the permission-gate rules exactly:
absolute paths, content fixed, nothing derived from a task, a branch or a project file,
and rewritten wholesale by the harness rather than merged.

**The KPI is engineering throughput per engineer**, not time-to-complete one task. The
harness exists to let one person supervise several concurrent tasks, which is why
gates, evidence and durable state outrank per-task speed.

- `domain/taskRoute.ts` — route + stage definitions, `StageKind`, built-in routes.
- `domain/taskPipeline.ts` — live state; plain JSON, round-trips through the repo.
- `domain/pipelineEngine.ts` — pure transitions. `nextAction()` reports what to do
  next; callers report back what happened. The engine never runs anything.
- **A severity section written without bullets still counts** (`parseReviewFindings`).
  `listItem` accepts only a bulleted line or one carrying its own severity marker, so a
  SQL review that headed a section "Critical" and listed three procedures on plain lines
  parsed to *nothing* — while the report, which shows the reply verbatim when nothing
  parses, displayed them. Three criticals on screen, an empty list in the decision, and a
  route that carried straight on. A section that yields nothing else falls back to its
  plain lines; a section with any bulleted item does not, because reading each line of a
  wrapped paragraph as its own critical is the over-count that teaches people to click
  past the stop. Inside such a section an *unmarked* heading is taken as a finding too:
  `looksLikeHeading` is loose by necessity, and "p_DescriptionCode line 171" satisfies it
  exactly.
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
- **Rule reviews run as early as the work allows, not as late as the barrier allows**
  (`ruleInsertionIndex`). The barrier — the first unresolved `deployment` or
  `humanVerification` — says *no later than*; on its own it also placed every review
  last, which is the expensive half. A send-back discards its target and everything
  after it, so each stage standing between the work and its review is one thrown away
  and re-run when the review finds something. On a real route a SQL review sat after
  the code review and the DEV landing plan, found a double-counted join, and cost both
  — three times over. Insertion is now after the **last** implementation stage before
  the barrier (splitting a change across two stages is common, and a review spliced
  between them reviews half a change), floored at the first unresolved stage so a
  pending review never lands in front of one that already ran.
- **A checklist belongs to the gate that reads it, not to the pipeline**
  (`domain/checklistScope.ts`, `ChecklistItem.scope`, `RouteStageDefinition.checklistScope`).
  `outstandingChecklist` pooled every unchecked item route-wide, so the **first**
  `humanVerification` gate absorbed all of them and every later gate had nothing left to
  ask for — a route could describe two verifications and only ever perform one. That
  matters because the two are different questions: run locally against the DEV database
  and you learn whether the change *behaves*; open it on the deployed DEV site and you
  learn whether it works where it is served, which is the only pass that catches a menu
  entry, a permission, a `Web.config` transform applied for one tenant, or an assembly
  that never deployed. Gates declare a scope, the behaviour review tags each item, and
  `itemsForGate` gives a gate only what it can answer for. Four rules, each load-bearing:
  **no declared scopes means the old behaviour exactly**, so nothing that has not opted in
  changes and there is no migration; **an untagged or misspelled item is assigned, never
  dropped** — to the last *unresolved* scoped gate, because an item nobody is asked about
  is worse than one asked in the wrong place, and assigning it to a gate that has already
  passed would block nothing at all; **a tag is only read as a scope when it names one the
  route declared**, so a review writing `[Excel]` does not have that silently removed from
  what the item says; and **a bulk tick cannot reach across gates**
  (`checkOutstandingChecklist`'s `forGate`), since ticking a site item at a local gate
  asserts somebody exercised a behaviour in an environment the change had not reached.
- **A gate also declares *who* answers it** (`ChecklistAudience`,
  `RouteStageDefinition.checklistAudience`, added 13 Aug 2026). Scope says which
  environment an item can be answered in; audience says whose job it is. `"others"` —
  testers signing off DEV, an external party accepting UAT — means the task has **left**
  the operator until feedback arrives, which is a different state from waiting on them,
  and `ui/taskGrouping.ts` files it under `Waiting on others` instead of padding the list
  they scan to decide what to pick up next. That was the whole complaint: `needs-you`
  mixed a click with a wait measured in days, which is the sifting problem that module
  exists to prevent, one level in. Keyed on **outstanding items for that gate**
  (`itemsForGate`), never the stage kind — an external gate with everything ticked is an
  approval only the operator can give, so it goes back in `needs-you`, and an item scoped
  to a gate nothing has reached yet must not file the task as delegated. A failed stage
  and a held tool call both outrank it: a broken route is the operator's whatever the
  task is nominally waiting on. **A gate that is still running is neither yours nor
  theirs** (20 Aug 2026): `active` was accepted alongside `awaiting-approval` in both
  `externalGate` and `groupForTask`'s verification branch, and it is the one status that
  means a session is in flight — `finishStage` settles a stage requiring approval to
  `awaiting-approval`, so a gate has stopped exactly when it reports that. RU-550's UAT
  acceptance sat in `needs-you` while its own session was running, asking for a decision
  about a checklist it had not written yet, and — the half that actually misleads — kept a
  running task out of `Working`, where every other kind with that status appears. The same
  status also gave `externalWaitSince` the session's own `startedAt`, so a gate that had
  waited on nobody displayed an age. The exclusion is the one `pending` already had, one
  transition later; a gate reaching `awaiting-approval` is unchanged, which is what keeps
  this a deferral rather than a gate switched off. Absent means `"self"`, so nothing that has not opted in
  changes; an unrecognised value is **rejected rather than defaulted**, because
  defaulting means `"self"` and that is exactly the failure the field prevents. The row
  carries the age of the wait in days or hours (`formatWaitingSince`) — moving these out
  of the scan list is the point, but testers do not notify the tree, and a delegated task
  with no visible age is a task you forget.
- **Gate wait is measured, and attributed** (`domain/gateWait.ts`, 13 Aug 2026). The
  other half of the audience change, and the half that touches the KPI. Session time is
  measured (`stageUsage`) and operator wait inside a session is measured
  (`humanWait`); time a route spent stopped *at a gate* was measured nowhere, so the only
  figure for it was wall clock — in which a well-run route waiting three days on testers
  is indistinguishable from a slow one, and optimising against that sends the effort at
  execution. Exactly the mistake the first latency measurement made, for the opposite
  reason.
  **Derived, never recorded**: a gate's `finishedAt` is the moment it settled into
  `awaiting-approval`, so it is when the wait began, and the `approval` intervention for
  that stage is when it ended. A new field would have to be written at approval time, and
  `interventions` already establishes that a call site with no clock records nothing — so
  deriving inherits that honesty instead of reporting a confident zero. Four rules:
  **unattributed time is yours**, because defaulting the other way moves it out of the
  column the harness is judged on and into the one it is excused for; **the first
  approval at or after the current `finishedAt`** ends the wait, since a re-opened stage
  overwrites `finishedAt` and approvals from a discarded run must not close it; **an open
  wait is reported apart from the closed totals**, or a growing number folded into a
  total makes one that changes on every render and reads as the measurement being
  unreliable; and a gate that plainly held the route up but left nothing to measure is
  **counted and announced** (`unmeasured`), the rule `stageUsage` follows for a subtask
  that reported no numbers. Rendered by `formatGateWaitLine` beside the execution total,
  never folded into it — "62m of session, 3 days with testers" is the only honest account
  of a route whose wall clock says three days.
- **The checklist review is spliced immediately before the gate that will read it.** The
  previous rule was "after the first deployment", which broke as soon as one route had two
  kinds: on `report-change` the first deployment lands the branch in source control and
  puts nothing in any environment — the next stage's own intent says so — so the checklist
  was written while the change was half-live, listing items whose SQL was not yet
  deployed. One `StageKind` was covering two different acts and counting deployments could
  not tell them apart; the consuming gate can. The no-gate fallback is deliberately still
  the first deployment.
- **`report-change` verifies before it shares** (project config, 11 Aug 2026). The old
  route merged into shared DEV and *then* deployed the SQL and asked for sign-off, so an
  unverified change sat in everyone's branch while it was still being checked. Now:
  commit and push the task branch → preview the SQL deploy → deploy it → QA checklist →
  verify locally against DEV → **merge into DEV** → sign off on the DEV site. Splitting
  the old "Land on DEV" in two is what makes that safe, and the half that matters is the
  check: deploying scripts that exist in no branch at all is the one thing the reorder
  must not allow, so the commit stage verifies with
  `Test-WorkLandedOnDev.ps1 -Upstream` — clean tree including untracked files, and the
  commits pushed to the branch's own remote.
- **A checklist-writing review goes *after* the first deployment, not before it.** The
  exact inverse, and it needs its own rule: a checklist is a list of things for a person
  to exercise, so a runtime QA stage raised before anything reached DEV produces items
  nobody can yet test, and holds the route on them. The barrier reasoning does not apply
  either — "before anything irreversible" protects a review asking whether an object is
  *safe to run*; a behaviour review asks how it *behaved*, which has no answer until it
  has. Keyed on `producesChecklist(kind)`, so stages are spliced one at a time rather
  than all at one point.

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
- **Every token of the hook command is quoted, unconditionally** — a live defect until
  17 Aug 2026, found only by running the gate against a real CLI. `quote()` quoted only
  values containing whitespace. The command is shelled, and on Windows these paths are
  backslash-separated: unquoted, the separators are eaten, `node` is handed a path that
  does not exist, the hook fails and emits nothing — **and emitting nothing means pass**.
  So the gate did not fire at all, which is indistinguishable from one waving every call
  through. Probed, same script and session each time:

  | hook command | fires |
  |---|---|
  | forward slashes, unquoted | yes |
  | backslashes, unquoted | **no** |
  | backslashes, quoted | yes |

  It worked in practice only by accident: the gate root sits under `globalStorageUri`, and
  the development machine's profile name contains a space, so every real path tripped the
  whitespace test. A profile without a space had no permission gate whatsoever, and no way
  to tell. The lesson generalises past this bug — where the failure is silent and the
  saving is nothing, do the safe thing unconditionally rather than deciding per value.

### Asking the user (`ask_user`)

The gate's twin, for information rather than permission. A stage that lacks
information used to reply `NEEDS-INFO` and end its session, so answering
**re-ran the whole subtask**. Instead the extension runs its own stdio MCP server
(`agents/askUserServerScript.ts`, shipped as a string) exposing one blocking
`ask_user` tool; `AskUserService` raises the question, and the answer returns as
the tool's **result**, so the agent continues mid-turn keeping everything it had
worked out.

- Verified: a `tools/call` held 45s, and both answers of a two-question call
  reached the agent in the same turn.
- `NEEDS-INFO` stays as the fallback. A stage that cannot ask must not guess, so
  the slow path is kept rather than removed, and `preamble()` names both and says
  which is cheaper.
- **The tool needs an allow rule.** Probed: under `acceptEdits` the server
  connects and the tool is advertised, the agent calls it, and the permission
  layer denies it — the agent then reports it cannot ask, which is the same dead
  end as having no tool. So `buildGateSettings` takes `allow`, and
  `ASK_TOOL_ALLOW_RULE` is the *only* thing that may be passed: nothing derived
  from a task, a branch or a project file.
- **`--mcp-config` is variadic, which is what makes this possible** — the
  project's own config and ours are passed under one flag rather than merging our
  server into a file the user maintains.
- **The server must never write to stdout except JSON-RPC.** A stray log line is
  framed as a protocol message and the CLI drops the server, so the tool silently
  vanishes. Diagnostics go to stderr; a test pins it.
- **Every `tools/call` gets a result.** Release and stop *abandon* outstanding
  questions with an instruction to proceed and declare assumptions, because an
  unanswered call otherwise blocks until the MCP timeout.
- `PendingQuestion.liveCallId` is the whole integration: a live question uses the
  same tree row, panel and answer flow as a `NEEDS-INFO` one, and only the submit
  handler differs — answer the waiting call, or enrich the brief and re-run.

### The setting was right and bounded the wrong quantity

24 Aug 2026. Questions kept dying in about seven minutes with `askTimeoutMinutes` at
**120**, and the state file said why nothing above was the cause: two failures in
`qubeautoapp`, both `asked N question(s) that were never answered`, **no**
`timed out after N minute(s)` at all. Blocked time 448s for one question and 919s for
two — the same ~450s twice, across two models, so a fixed bound and not an operator
giving up. The installed build did set `MCP_TOOL_TIMEOUT`, and neither setting was
overridden anywhere.

**The CLI bounds elapsed time and silence separately, and a question is bounded by
silence.** `MCP_TOOL_TIMEOUT` caps the call; a *second* mechanism aborts a call that has
sent "no response or progress notification" for a while, configurable as
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` or, per server, as a `timeout` field. A blocking
`ask_user` is silent by design — blocking *is* the mechanism — so it is the textbook idle
server, and the one setting named after the behaviour governed a quantity that was never
reached. Same shape as the unquoted hook command: the feature looked configured, the
setting existed, and the thing it named was not the thing in control.

**Declared per server, not through the global env var**, which the CLI's own message
offers as the alternative. The global switch also lifts the abort off the project's own
MCP servers in every stage session, and there a silent server really is a wedged one —
the stage would hang to the stage timeout and be recorded as a hung CLI, which is the
misattribution this whole area keeps producing. Ours is the only server the harness knows
is *meant* to go quiet. Absent leaves the field off entirely rather than defaulting, the
rule an unmeasured wait already follows, and a tiny value is clamped to a minute for the
reason `askTimeoutEnv` clamps.

**Probed on CLI 2.1.223**, and designed to make the field bite *earlier* than the default
so the answer arrives in seconds rather than minutes. A stdio server whose one tool never
replies and sends no progress, called from an untrusted cwd through `--mcp-config`:

| server entry | outcome |
|---|---|
| `"timeout": 20000` | aborted, `tool "wait_forever" timed out after 20s` |
| no `timeout` field | still blocking at **120s**, when the probe was killed |

So the field is honoured on a `--mcp-config` server, which was the open question — the
CLI's message mentions it only for a server "configured in your MCP settings".

**Not probed, and adjacent:** `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` sits beside these. A
long call being auto-backgrounded would be a third bound with a third failure shape, and
nothing here has looked at it.

### The shorter of two timeouts always won

`domain/stageTimeout.ts`, 24 Aug 2026. `askTimeoutMinutes` (120) sets `MCP_TOOL_TIMEOUT`
so a question can wait human latency rather than machine latency — and
`stageTimeoutMinutes` (45) was a flat wall-clock `setTimeout` over the whole subtask, so
a question could never actually outlive **45** minutes whatever the ask timeout said. The
setting whose own description says it bounds a *hung CLI* was bounding a person thinking.

Worse in the direction that misleads: when it fired, the subtask was recorded as
`timed out after 45 minute(s)` — a hang. That is `transientFailure`'s complaint arriving
by another route, a wait that was never the stage's doing charged to the stage, and the
remedy the operator reaches for is the wrong one.

The timer now **re-arms** rather than firing once, and the budget is *working* time:
elapsed minus the human wait the harness already measures. Four rules:

- **The wait must include one still open** (`AskUserService.blockedMs`). `humanWaitMs`
  counts settled waits only, which is right for the usage totals it feeds and exactly
  wrong here — a stage blocked *right now* is the case this exists for, and it
  contributes nothing to the settled tally, so a timer reading that would see the whole
  wait as working time and kill the stage for waiting.
- **Unmeasured wait is working time.** A runner built without the reader behaves exactly
  as it did before. Defaulting the other way switches the hung-CLI bound off wherever
  the ask channel is unavailable, which is precisely where a hang cannot be a question.
- **A re-arm has a floor** (30s). A stage that had nearly used its budget and is now
  blocked has ~0 remaining while the open wait keeps growing, so an unfloored re-arm
  fires again immediately for as long as nobody answers. The cost is overshooting the
  budget by up to the floor, which is the right trade against a spinning timer.
- **Announced when it re-arms**, because a stage sitting past its own stated limit is
  otherwise indistinguishable from the cap not working — the rule truncated output and a
  discarded file both follow.

**An unlimited timeout is not the answer to either**, and the reasons differ. Unlimited
*stage* timeout removes the only protection against a wedged CLI, and a route that never
advances then looks identical to one waiting on you — the failure that tells you which is
the thing lost. Unlimited *ask* timeout is closer to defensible, since a question waiting
overnight is the designed case, but MCP has no cancel: an unanswered call holds the
session, its context and its process open, and `release`'s abandon path is what
guarantees every `tools/call` gets a result. Something has to end it; a bound with a
message beats a cliff with none.

### Seeing and steering a run

Three related facilities, all answers to "the pipeline is a snapshot and the
sessions are invisible":

- **`domain/stageRefresh.ts`** — `refreshPendingStages` reloads `intent` and
  `model` from current config for stages that have **not started**, run at the top
  of every advance. A stage that has already run keeps what it ran with, so history
  stays truthful. `splittable` is deliberately excluded: it decides how many
  subtasks a stage has, so refreshing it would reshape a pipeline mid-flight.
  `revertToStage` re-opens a stage *and everything after it*, discarding those runs
  (including their checklist items, which otherwise gate the task on evidence about
  work that no longer exists) but **keeping the operator's guidance**.
- **A route that reorders its stages has to reach tasks already in flight**
  (`repositionRouteStages`). `addMissingStages` covered a route that gained a step and
  nothing covered one that *reordered* the steps it had — yet reordering is how the most
  consequential corrections are expressed, because their whole point is that one stage
  must happen before another. `report-change` was corrected to deploy its SQL and have a
  human verify the change locally *before* merging into shared DEV; a task already
  running got the two new stages inserted correctly and kept `Land on DEV` where the old
  route put it, in front of the deploy. So the gate the correction existed to add ran
  after the change had already been shared — the exact state it was written to prevent —
  and nothing said the pipeline disagreed with config. Pending route stages are permuted
  **among the slots they already occupy**, which is what makes it safe without a separate
  frontier check: a settled stage, a rule-added one, or one the route no longer defines
  holds its index, so nothing can cross it. A stage counts as begun if its status has
  moved *or* any subtask has started. Rule stages are left to `repositionRuleStages`,
  which runs after this — their position comes from `ruleInsertionIndex`, not route order.
  A stage the route reordered but which has already settled stays wrong, deliberately:
  the only honest repair is `revertToStage`, and that discards work, so it is a human's
  call.
- **A re-run takes a reason, and the reason is guidance.** `revertToStage` had no input
  the operator could change: everything it reloads comes from project config, so
  steering one task meant editing the route every task shares — and the account of what
  went wrong was usually written by the run being discarded, so it went out with it. A
  cold re-run then reached the same answer for the same reasons, which is what made
  re-running look like it did nothing. The command now asks why, before confirming,
  and files it as guidance: cumulative, passed to every stage, ranked above the brief.
  Guidance rather than a field of its own, because a second channel with the same
  meaning is one the prompts have no way to rank against the first. Escape cancels the
  re-run rather than meaning "no reason" — the box is the first thing shown, so
  dismissal must not lead to a destructive confirmation.
- **Guidance is scoped, because not all of it is advice** (`guidanceFor`,
  `GuidanceNote.scope`). Everything used to reach every stage, which is what an approval
  note means and not what the two later kinds are. A send-back's findings and a re-run's
  reason are about *one stage's output*; delivered route-wide they become permanent and
  outrank each later stage's brief. Both halves of that bit in one morning: a DEV
  deployment preview was handed three reviews' findings fixed two stages earlier and
  spent part of its report declining to re-litigate them, and a re-run inherited a
  correction's bug report about the build it was replacing and stopped to ask three
  questions about an exception that no longer existed. Stage-scoped notes go to their
  stage only, and only while it is unresolved — once it has passed the note either worked
  or came back as a new finding. Absent scope means route-wide, so existing pipelines are
  unchanged. The UI had always agreed: `stageReport` filters guidance by stage for
  display, so the report claimed a stage was told less than it was.
- **Approval notes** (`TaskPipeline.guidance`) — approving asks for an optional
  note. It is cumulative, handed to every later stage via `StageContext.guidance`,
  and the prompt says it outranks the brief. The gate is the one moment a human has
  just read what a stage produced and knows something the route does not; without
  somewhere to put it, acting on it meant editing the brief or re-running a stage.
- **A report has to be openable.** `formatTaskReport` embedded every stage's full
  report, so a real 22-stage route rendered to **394KB of markdown** — which VS Code's
  preview will not open, so "Show What This Did" appeared to do nothing at all. Command
  output is what fills it: `MAX_OUTPUT_CHARS` caps it per *subtask*, so a stage with
  three carries three times the cap and the route carries the sum of every stage. The
  whole-task view now summarises — status, evidence, verdict, cost, and any stage that
  says it did not do its work, which is never summarised away because it is the reader's
  reason for opening the report — with the detail one click away on the stage row.
  `MAX_REPORT_CHARS` is the backstop for a single stage, announced rather than silent,
  since output that simply stops reads as the command having stopped.
- **`agents/stageActivity.ts` + `ui/stageReport.ts`** — a stage session's reply used
  to be parsed for a marker and discarded, so a deployment preview that printed
  pages of output left nothing behind. `StageActivityWatcher` (fed from the same
  subscription as `DenialWatcher`) records tool counts, commands **verbatim**, files
  written/read and command output; `formatStageReport` renders it as markdown.
  Output is capped (`MAX_OUTPUT_CHARS`) because it lands in the state file, which is
  read and rewritten whole — and truncation is announced, since output that just
  stops reads as the command having stopped.

### Correcting a stage instead of demolishing it

The gear the harness was missing, and the reason acting on a review finding had
become irrational. Every correction was stage-granular: `revertToStage` discards the
stage and everything after it, so a one-line cast error and a wrong approach cost the
same — on a real route, **$12.48 and 44 minutes and 15M cached tokens to change a
type**. The only repair tool was demolition, so the cheapest response to a finding was
to ignore it.

`correctStage` (`pipelineEngine.ts`) appends a **correction subtask** carrying the
finding, and **keeps everything the stage already produced** — replies, activity, cost.
`Subtask.correction` marks it, so a stage fixed three times is distinguishable from one
split into three units. The stage's `verdict` and `verification` are dropped, because
both were about the version being corrected.

`correctionPrompt` is where the saving is: the session is handed **the stage's own
previous report** and told what is wrong with it, so it does not re-read the ticket,
re-derive the codebase or re-decide an approach. The instruction is deliberately
*narrowing* — left to itself a capable model treats a finding as an invitation to
improve the surrounding code, and a correction that rewrites half the stage costs what
the re-run cost *and* invalidates the reviews that had passed the rest. A fix that needs
a change of approach is told to stop and say so: that is a re-run, and a human's call.

**Later stages are amended, not rebuilt** (`domain/upstreamAmendment.ts`, 17 Aug 2026).
They are still re-opened — they ran against output that just changed, and nothing here
skips work or lets a stage stand as passed on evidence that moved. What changed is where
they start from.

The claim this replaces was that re-opening them is affordable "because those are the
cheap ones: 4 of 20 stages are implementation and the other 16 are gates, promotions and
reviews, and the gates are free". Measured, that is false twice over. Non-implementation
rework across eight pipelines was **120 runs, 423 min, $107**. And in one 2.5-hour window
on 17 Aug, **$59.10 of $97.34 — 61% — was downstream stages re-running**, from exactly
three corrections: a `Plan` correction taking 17 stages with it at $30.35, a `Plan the
load` correction taking 4 at $15.95, an `Implement the data` correction taking 14 at
$12.79.

The work was not wasted; those stages genuinely had to respond. What was wasted is that
each started **cold** — `reopenAfter` cleared `reply` and `activity`, so a stage
absorbing "the comparison dropdown is now two dropdowns" re-read the ticket, re-derived
the codebase and re-decided its approach. The repeats show no learning curve at all: one
task's `Implement the data` was discarded six times at $1.50, $4.33, $9.41, $3.13, $2.51
and $10.94.

The harness already had the answer and was applying it one stage too narrowly.
`correctStage` exists because a cold re-run cost $12.48 and 44 minutes to change a type,
and it fixes that by handing the session its own previous report — a saving that reached
only the stage the operator corrected. It now reaches the stages behind it. Rules:

- **Evidence is still cleared** — verdict, verification, checklist, plan steps. All of it
  certified a version that has moved, and keeping any of it is the failure re-opening
  exists to prevent. Only the *replies and activity* survive, because those are context,
  not certification.
- **An amendment is not a correction**, and `Subtask.correction.upstream` keeps them
  apart. Three corrections is a stage that got its own work wrong three times; three
  amendments is a stage that was right each time and had the ground moved under it — and
  a ledger conflating them points the next investigation at the wrong stage.
- **Nothing amended is booked as discarded.** `discarded` is the number that says what a
  correction cost, and booking retained work into it would report the saving as though it
  had never happened.
- **Withdrawing a correction now restores rather than re-opens** (`withdrawAmendments`).
  Each amendment carries the settlement its stage had beforehand, so a withdrawn finding
  costs those stages nothing. The old note on `CorrectionUndo` — that no snapshot could
  bring the later stages back — was true only because their replies had already been
  destroyed.
- **An amendment that has not run absorbs the next correction rather than sitting beside
  it** (24 Aug 2026). Amendments appended unconditionally, so eight corrections of two
  stages left **69 never-run amendments across eight downstream stages** on
  `Purchases vs Sales Phase 3` — 77 sessions to reach the first gate against a
  `MAX_STEPS` of 40, so the advance exhausted before it could stop anywhere a human
  would see why. Every one of those notes describes a delta against the *same* unrun
  base output and opens with "your previous output is above", so delivered separately
  they each pay a session to re-read it: this is `correctStage`'s own argument — do not
  start cold — applied to the amendments of one stage instead of the stages behind one
  correction. A round that produced nothing is not a round, which is also what keeps
  `stageHistory` honest, since it renders each as a distinct account of the stage.
  Restricted to the **same upstream stage**, which is what makes it free: `withdrawAmendments`
  matches on `upstream.stageId`, and a subtask absorbing two stages' corrections could be
  attributed to neither. It keeps the **earliest** `at` and `undo` — the settlement
  withdrawal already reaches for — so withdrawing the later of two absorbed corrections
  restores further back than that one alone, honest for the same reason absorbing is safe:
  no work happened between them. The raw findings are kept on `upstream.findings` because
  `finding` is the *composed* note, and merging notes would mean parsing prose back into
  its parts; an amendment predating that field is appended beside rather than absorbed,
  since nesting one note in another hands the stage two sets of instructions — the failure
  `HANDOFF`-beside-`VERDICT` already taught this codebase. Raising `MAX_STEPS` is the wrong
  lever and its comment was stale either way: "a real route is well under ten steps" was
  written against routes far shorter than the 29-stage, 178-subtask ones now running.
- **A change too large to amend is still a rebuild**, declined through the existing
  `CORRECTION-DECLINED` path, which is honoured on exactly these subtasks. The note names
  no marker itself: `correctionPrompt` already states it, and the domain has no business
  naming an engine's protocol.

Not addressed, and worth separating: on `Purchases vs Sales Phase 3` the corrections were
**requirement changes** — seven to `Plan` alone, the last splitting a dropdown in two.
The cascade there was correct invalidation, and the rising price per episode ($22.97 →
$23.59 → $30.35, as the route gets further each time) is a requirements-stability
question, not a runtime one. Amendment makes each episode cheaper; it does not make late
requirements free.

**A correction may refuse, and refusing had to become a fact the parser reads.**
`correctionPrompt` has always told the session to stop and say so when a finding needs a
change of approach — and gave it nothing to say it *with*. So the reply came back as
prose, the session had not errored, `finishSubtask(..., "done")` recorded a process
exiting tidily, the stage settled and the route advanced: later stages built on output
the correction had just confirmed was wrong, and the finding was marked dealt with. The
prompt asked for a behaviour the parser did not look for, which is exactly what "never
trust the reply to be well-formed" is a rule against — the fifth instance of that one
disease, after `DEFERRED`, `BLOCKED`, `ACTION` and the plan step. It cost a grid rebuilt
from the wrong wireframe tab, with an eloquent explanation attached.

`CORRECTION_DECLINED_MARKER` closes it, held on the same machinery as `BLOCKED` —
recorded, then `holdStageForFindings` — because it is the same shape of fact: the stage
did not do what it was asked and must not be recorded as having done it. Kept a separate
marker from `BLOCKED` because **the remedy differs and the remedy is the point**:
`BLOCKED` says a prerequisite is missing and someone must supply it; this says the
output is wrong in a way no targeted edit reaches, and the answer is `revertToStage`,
which only a human may choose. Honoured **only on a correction subtask** — an ordinary
run has no correction to decline, so the line there is a model quoting the protocol
rather than using it, and the marker's first visible effect must not be a false stop.

**And the marker was still not emitted** (`correctionChangedNothing`, 19 Aug 2026). A
`Plan` correction carrying a real scope change — a `TLC Activated` column, an activation
date sourced from `p_Load_TLCActivations`, a bucket rule replacing the
registered-but-not-activated filter — reasoned it correctly and at length in prose: *"this
is a scope change from what the plan documented, not a small correction."* It wrote no
file and used no line. The stage settled `passed` with the plan document unchanged, and
the eight stages behind it ran against it — two cold, six amended — each declining in
prose in turn, until `rc-dev-promote` failed eight stages later with nothing to ship.
Seventh instance of the same disease, and the second to be closed the only way that
needs no cooperation: `changedNothing`'s argument, applied to the correction subtask. A
correction exists to change the stage's output, so one that changed nothing corrected
nothing, whatever its reply says. Narrow in four ways — **a correction, never an
amendment**, since *"nothing in this stage's output changes"* is a correct amendment
outcome and holding on it would fire across most of a cascade; **any stage kind**, unlike
`changedNothing`, because every medium `correctionMedium` names is a file; **held, never
failed**, since "the finding was wrong" is a legitimate no-write answer and still a claim
about a finding somebody raised; and **absence of activity means unmeasured**. Checked
only when no marker was parsed, so a properly declined correction keeps the better
message — that one names the remedy.

**Sending findings back defaults to fixing them.** Most review findings are a thing to
correct, not a reason to rebuild, so the send-back flow offers the correction first and
the re-run as the deliberate choice — the reverse of how it started, which is what made
acting on a review cost a whole stage. The fixing stage is given the *same* text it
would have received as guidance (`formatSendBackNote`), naming the review that raised
it: by the time the fix runs, the reviewing stage's own output has been cleared, so
without the attribution the findings arrive from nowhere. The choice is only offered
when the target has something to correct — a stage that never ran, or whose output an
earlier revert discarded, gives a fix session nothing to start from.

### Work that was already under way

Three entry points, because pre-existing work arrives in three shapes and only one of
them was served:

| What exists | Way in |
|---|---|
| A worktree with no task | **Adopt Worktree as Task** (already existed) |
| A task with no route | **Attach a Route…** |
| A branch, and nothing else | **Create Task from Existing Branch…** |
| Nothing in git at all — work that exists only in an environment | An ordinary new task, with assessment offered at creation |

The last row is the one that breaks the assumption underneath all the others: SQL
deployed to DEV before it was ever in source control, or a task closed to be migrated
onto the harness. There is no branch to adopt and no worktree to take over, so the way
in is a normal new task — and the assessment stage has to look somewhere other than the
diff. Its prompt now names the environments as a place to look, and states the rule that
keeps this from disabling the route it is attached to: **a thing that exists in an
environment but not in the repository is `not done`**, because bringing it under source
control and through review is precisely what the route is for.

The third is the one that had no path at all: `createWorktree` always passes `-b` and
explicitly refuses an existing branch, which is right for new work and made older work
unreachable. `addWorktreeForBranch` checks the branch out **as it stands** — nothing
rebased, merged or moved, since the work on it is the whole reason it matters — and
`createTaskFromBranch` records it. Base branch is *asked for*, never guessed: it is what
later stages diff against, so a wrong answer makes every review read the wrong changes.
It runs the same provisioning as a new task and goes straight into the route picker.


`createPipeline` was reachable from exactly one place — task creation — so work already
started could never enter the runtime, and the fallback was a chat session outside every
gate the harness provides. **Attach a Route…** (`attachRouteCommand`) fixes the entry
point; it refuses a task that already has a pipeline, because a pipeline holds
approvals, checklist items, deferrals and handoffs, and replacing it would discard them
silently.

Attaching offers an **assessment stage** (`StageKind "assessment"`,
`assessmentStageDefinition()`, prepended — synthesized rather than required of every
project's route file, since it is a property of how the task entered, not of the work).
It reads the worktree and reports `ASSESSED: <stage id> done|not done — evidence` per
stage. The alternative was letting the operator tick off stages they believe are done,
which records work as complete because somebody said so — the exact failure the harness
exists to prevent.

Three rules make it safe:

- **Recorded, not applied.** `recordAssessments` stores the mapping; `approveStage`
  applies it. The gate is the point — a person reads the evidence before any stage stops
  running.
- **Skipped, never passed.** A stage that ran has a report and possibly a `verify` exit
  code; an assessed one has an agent's reading of a diff. `skipReason` carries the
  evidence so the two can never be confused later.
- **Only pending stages.** A conclusion about a stage that already resolved, or about
  the assessing stage itself, is dropped rather than allowed to rewrite history.

The prompt tells it to judge *existence, not quality*: a stage marked done is skipped,
so its review never runs — if the work looks wrong, that is "not done".

### A stage knows the route it is part of

`StageContext.routeStages` — every stage in order, intents included, with this one
marked. Built from the **live pipeline**, not the route definition, so rule-added
reviews appear; a stage told a route that omits them would raise the very work those
reviews exist to do.

Added because a behaviour review raised "deploy this migration to DEV" as a
verification item for a human, when the route already had a deployment stage two steps
later. The stage was not wrong that the work was outstanding — it had no way to know
anyone was going to do it. A cold session cannot rediscover this at any price: the
route is not in the repository, the diff or the brief.

It is also what gives `DEFERRED` its meaning. The engine defines a deferral as work
belonging to **no stage**, and until this existed no stage could tell that from work
belonging to the next one — so the careful ones over-reported and the rest said nothing.

### Four accounts of one stage, in the same typeface

`domain/stageHistory.ts`, 19 Aug 2026. `correctStage` keeps everything the stage
already produced — that retention is the whole saving — and the report rendered the
result as one `## What the agent reported` after another, chronological, visually
identical. A stage corrected twice and then amended after an upstream correction
presented **four indistinguishable accounts of itself**, and the finding each round was
acting on appeared nowhere at all: `Subtask.correction.finding` was persisted, handed to
the session, and never rendered. So the reader could see that something had been fixed
three times and not what any of it was for, and had to infer which reply still stood
from position on the page.

Three facts no reply contains, and the module derives all three from what is already
persisted, so it reads correctly for stages recorded by earlier builds:

- **Which round stands** — named in the heading, and stated once at the top
  (`summariseStageHistory`, rendered as `How it got here`).
- **What each repair was asked to fix** — `roundHeading` puts the finding in the heading,
  headlined through `deferralHeadline` for the same reason the settlement box does.
- **Correction versus amendment** — the distinction `Subtask.correction.upstream` exists
  to keep. Three corrections is a stage that got its own work wrong three times; three
  amendments is one that was right each time and had the ground moved under it, and a
  report conflating them points the next investigation at the wrong stage. An amendment
  is labelled with the stage whose correction caused it, and its `finding` is
  deliberately *not* headlined — it is the boilerplate `upstreamAmendmentNote` composed,
  not a finding, so a headline of it would say nothing.

Four rules:

- **A split stage has no round that stands.** Parallel units are one round of work done
  in several sessions, and marking the last-listed of them as the current version would
  be a statement about nothing. `latest` is set only where a repair exists.
- **A stage nothing corrected renders exactly as before**, summary line absent — the rule
  the scope declarations follow. The line appears only where it tells the reader
  something.
- **Superseded repairs fold away only on a settled stage.** Someone reading a `running`
  or held stage is watching a repair rather than reading a conclusion, so everything
  stays open. Folding is honest only because the `<summary>` carries the finding: the
  reader can tell what is inside without opening it.
- **The per-round `What the agent reported` heading is gone**, since the round heading
  already says whose account it is and what it answers. It was the noise a corrected
  stage had four of.

### A post-condition no stage can satisfy, and a link nothing looked for

`domain/pullRequestEvidence.ts` + `RouteStageDefinition.requiresPullRequest`, 20 Aug 2026.
Two defects found in one failure on `RU-550`, and they are the same failure seen from
each end: the route asked a human for something and told nobody, then checked for it in
a place it could never be.

**A verify runs before its own stage's gate, so it cannot check a human act.**
`rc-uat-promote` says in capitals *"PROMOTION IS BY PULL REQUEST, NEVER A DIRECT PUSH"*
and carried
`Test-WorkPromoted.ps1 -TargetBranch UAT`, which asks whether the commits are **on**
`origin/UAT` — true only once somebody merges the pull request. `pipelineRunner` runs a
stage's verification when its last subtask finishes, *before* the gate, so a perfectly
executed promotion failed every time: `6 of 6 commit(s) for RU-550 are not on
origin/UAT`, reported against work that was pushed, complete and waiting. The exit code
was a confident statement of the wrong fact — the same shape as the `${ticket}` scoping
failure, which reported "not promoted" when the truth was "not scopable". A check whose
subject is a human act belongs on the first stage **after** the gate that asks for it,
so the check moves onto the **next gate the route already had** — `*-uat-acceptance`,
which is also the honest place for it, since UAT acceptance cannot mean anything about
code UAT does not hold.

**A merge is not a stage, and making it one produced a test.** The first fix inserted a
`*-uat-merge` / `*-live-merge` stage to give the merge somewhere to live. It had to be
`kind: "humanVerification"` to be a gate at all — and `producesChecklist` counts that
kind, so the harness dutifully asked each new stage for behaviour checklist items. A
merge gate arrived asking the operator to test things. The kind system has no entry for
"a human performs one deterministic act", and inventing one for a single act that
already sits next to a gate is the wrong trade: the instruction now prefixes the
acceptance and live-verification intents that were always going to be read anyway. The
general lesson is the one `StageContext` is built on — *eliminate high-confidence
uncertainty, do not add structure* — and a stage is structure.

**And nothing said the merge was owed.** The instruction to open a pull request lived in
the *promote stage's intent* — addressed to the agent, never rendered for the operator —
so the only party told was the one that cannot merge. The gates that follow now say it
first, and say what the failing check will look like while the pull request is open:
unmerged, not unpromoted.

**The URL is checkable, and it was the thing that went missing.** The stage
cherry-picked, pushed, wrote a full account headed `## Promote to UAT: done`, and never
opened the pull request. Tenth instance of the reply-claims-an-outcome-the-parser-cannot-
check disease, after `DEFERRED`, `BLOCKED`, `ACTION`, the plan step,
`CORRECTION-DECLINED`, `changedNothing` and `correctionChangedNothing` — and the
cheapest of them to close, because a pull request URL is the one artefact of such a
stage that leaves **no trace in git**. Everything else it did can be reconstructed
afterwards; the link cannot, which is both why its absence is invisible and why looking
for it is an exact statement of what the stage owed.

Five rules, each load-bearing:

- **Declared, never inferred from the kind.** A `deployment` stage is not necessarily a
  pull-request stage — `live-incident`'s `li-reconcile` cherry-picks onto the target
  directly and by design, and holding it for a link it was never asked for is how a
  check gets switched off. Rejected rather than coerced at parse time, unlike `handoff`
  beside it: a boolean misread as absent turns *this* check off silently, which is the
  failure it exists to catch.
- **Held, never failed.** A live publish may legitimately open fewer pull requests than
  there are targets, since a change that does not apply to RenaultGB opens none for
  `LIVE_MultiMarket`. Holding costs one click; failing costs a re-run of a stage that
  did its job.
- **At least one, never a count.** "Three live branches, three URLs" is the obvious
  refinement and wrong for the reason above — the correct number is a property of the
  change, not the route. One URL separates *opened some* from *opened none*, which is
  the distinction that actually failed.
- **Keyed on the URL's path segment, not its host.** Bitbucket, GitHub, GitLab and Azure
  DevOps all work with no host list to maintain, and a repository URL, a branch URL or a
  Jira link does not qualify. The RU-550 report contained all three and no pull request.
- **Read from the replies, not from activity.** A pull request can be opened through the
  web UI, an MCP tool, `gh`, or the create link a push prints, so no command or written
  path marks it reliably. What the stage owes is identical in every case: the URL, in
  its report, where a human can click it.

Not fixed, and deliberately: no verify was added to the per-tenant live verification
stages. Each may legitimately be skipped for a manufacturer the change does not affect,
and `Test-WorkPromoted` **fails** on a ticket it matches no commits for — a gate that
fails on a correct skip is one people learn to click past. They are told about the merge
in prose instead, which is all a gate with no admissible check can honestly do.

The declaration is doing the work the extra stage was added for. On the run after
`requiresPullRequest` shipped, the same promote stage opened the pull request and
reported it — which is the outcome the merge gate was standing in for, arrived at by
holding the stage that owed it rather than by adding a stage to notice afterwards.

### Processes the harness started, and the one it must never touch

`domain/sessionProcesses.ts` + `services/sessionProcessRegistry.ts`, 26 Aug 2026.
`AgentSessionManager` keeps sessions in a `Map<taskId, ClaudeStreamSession>`,
`stop()` calls `child.kill()`, and `dispose()` reaps every session on deactivate — so
stopping a task really does end its process and a clean reload leaves nothing behind.
What none of it survives is the extension host **crashing**: the map goes with it, and
a live stage session keeps running with no record of its pid, no owner, and nothing
that will ever kill it.

The registry writes pid, task, subtask and spawn time at `create` and clears it at
`stop`; an activation sweep decides what to do with whatever is left.

**The rule that matters most is only ever reap what we started**, and it is written
from nearly getting it wrong. Investigating a stopped task, a listing of every
`claude.exe` on the machine showed three running for two days, and they were called
orphaned stage sessions. They were the operator's **chat tabs** — one of them the
session having the conversation — and a sweep keyed on the process name would have
killed all three. The tell was in the command line (a stage session carries
`--plugin-dir`, `--mcp-config` and `--tools`; an interactive one carries
`--replay-user-messages` and none of the three), but the honest fix is not a better
classifier: it is to never classify. A process is a candidate only because the harness
wrote a record when it spawned it, and anything unrecorded belongs to somebody else
whatever it looks like.

Rules, each load-bearing:

- **Never on a pid alone.** Pids are reused, so a record surviving a crash may name a
  process that is now something else — quite possibly one of those chat sessions.
  Liveness is necessary and not sufficient; the probe must also say the process started
  when we say we did, within a deliberately generous tolerance. A pid that started far
  later is *forgotten*, not killed.
- **An unidentifiable process is kept.** Where the platform cannot supply a start time
  the answer is keep, the direction `WorktreeDiscardService` and the unmeasured-wait
  rule already choose: absence of measurement is not permission to act. Windows gets a
  real answer from one CIM query for every pid at once; elsewhere the field is absent
  and nothing is ever killed.
- **A hand-driven session is unreapable by construction.** Its record carries no
  subtask, so there is nothing that can have gone inactive — safe by shape rather than
  by a check somebody could get wrong. The same line `--tools` and the protocol skill
  draw: the runtime narrows a stage, never a person.
- **Keyed on the subtask, not the stage.** The operator's instinct was to compare
  against the current stage and kill anything working on an earlier one; the subtask is
  both simpler and stricter, and it catches the case the stage test misses — a subtask
  reverted by a stop, a question or a transient failure leaves the stage unchanged.
- **Kills are announced.** This is the one part of the runtime that terminates
  something, and a kill nobody can see afterwards is indistinguishable from a process
  that was never there — the rule a discarded file and truncated output both follow.
  Nothing is said when nothing happened.
- **Not on the state file.** A pid is an ephemeral machine-local fact; `state.json`
  lives under the git common dir, is shared by every worktree and window, and is the
  durable record of the work. This sits beside the permission gate root under
  `globalStorageUri`.
- **Non-fatal throughout.** A sweep that cannot read its registry, probe the OS or kill
  a process leaves everything as it was. It runs at activation, and failing activation
  over a tidy-up trades a leaked process for a broken extension.
- **Activation only.** A periodic sweep is the obvious extension and the wrong trade:
  the records are written by this window, so the only moment a live process can lose
  its owner is a host restart, and probing on a timer spends a PowerShell spawn to
  learn nothing.

Found on the way: **`child.kill()` is not a tree kill on Windows.** The CLI spawns
tool and subagent processes of its own — 7% of stage sessions use the Agent tool — so
a stage that had delegated left its children behind. The sweep uses
`taskkill /T /F`. The in-session `stop()` path still calls `child.kill()`, which is
the pre-existing behaviour and a separate question.

### A revert that replayed the repairs of the run it discarded

`dropRepairs` in `revertToStage`, 26 Aug 2026. The module already states the rule
twice, in its own comments, about the two fields beside it: re-opening a stage clears
its `checklist` because keeping it "would gate the task on evidence about work that no
longer exists", and clears `planSteps` for the same reason. It then mapped every
**subtask** to pending, correction subtasks included.

A correction exists to fix one specific version of a stage's output; an amendment
exists to absorb one specific upstream change. A revert throws that output away and
re-runs the stage cold, so every repair against it is meaningless by construction —
the identical argument, one field along, never applied.

Measured on NMGB-2814. A revert on `rc-implement-sql` re-ran the stage correctly
(twelve files, on Opus) and then re-opened **seven historical corrections** as pending
work: findings from three separate days, 12,000 to 16,000 characters each. The first
ran, correctly found nothing to do — its finding was about `Index.cshtml:62` and a
period dropdown fixed two days earlier — wrote no files, and was held. Six more were
queued behind it, and `rc-implement-app` had **twelve**, giving nineteen Opus sessions
whose whole content was re-reading findings about versions that no longer existed.

**`correctionChangedNothing` is what made it visible**, and it had shipped that
morning. Without it the first replay would have settled `passed`, the route would have
carried on, and the cost would have read as the task simply being expensive. Worth
recording as the first case where one of these checks caught a defect in the harness
rather than in a stage.

**`narrowAmendments` does not reach these.** It is keyed on `upstream.stageId`, so it
absorbs amendments of a common upstream stage and a plain correction — which has no
upstream — is invisible to it. Filtering on the presence of `correction` covers both
kinds, which is the right key: what matters is that a subtask is a repair, not what it
is a repair of.

Two rules:

- **Never empties the stage.** A repair implies a base subtask beside it, but if
  filtering removed everything the original list is kept, because a stage with no
  subtasks is skipped rather than re-run — a worse outcome than replaying one repair.
- **Every base subtask of a split stage survives.** The parallel units are the stage's
  own work, not repairs of it.

### Two stages that both deployed to DEV, named the other way round

`refreshStageLabels`, 26 Aug 2026. A second operator trying the harness read
`report-change`'s **"Deploy to DEV"** as the C# deployment. It runs
`Invoke-SqlDeployment.ps1` and touches no compiled code at all; the code reaches DEV
at the stage called **"Land on DEV"**, which merges the task branch — and with CI/CD
building the DEV branch, that merge *is* the deployment. So both stages deploy to
DEV, the names said neither, and the natural reading was the wrong one. He concluded
work had been missed; nothing had.

The labels are project config, so the renames are a `harness.json` edit — and the
useful framing came from the CI/CD fact: name what each stage deploys rather than
calling one a deploy and the other a merge, since understating the merge hides that
it is the irreversible act putting code on the shared site.

The harness half is that **`label` was refreshed by nothing**. `refreshPendingStages`
carries `intent`, `model`, `verify`, `planFile`, `planOutput` and
`requiresPullRequest`; `refreshGateDeclarations` carries the two gate fields. A rename
therefore reached no task already in flight — the same class of bug as `checklistScope`
never reaching the gates that sit longest, and biting in the same place, because a task
somebody is confused by is by definition one already running.

A third pass, with the **widest rule of the three**, and the width is the whole point.
`refreshPendingStages` touches nothing that has begun, because an `intent` is an
instruction given to a run and a stage that ran must keep what it ran with.
`refreshGateDeclarations` goes one status further, because a scope and an audience
decide what happens next. A label decides *nothing*: no prompt quotes it, no parser
reads it, no evidence depends on it. It exists so a person scanning the tree knows what
a stage is — so a **settled** stage needs the corrected name most, since the history is
what gets read afterwards. Only the label; everything else about a settled stage is a
record of what happened.

Found on the way, and the reason the three passes are worth one comment: the sync site
chains them and saves the **last** pipeline. Written as two it saved `paths.pipeline`;
adding a third pass without moving the save would have computed every rename and
discarded it — a silent no-op indistinguishable from the feature being absent, which is
the failure the unquoted hook command already taught this codebase.

### A plan that said it was not finished

`domain/planQuestions.ts` + `RouteStageDefinition.planOutput`, 26 Aug 2026. The
twelfth instance of the reply-claims-an-outcome-the-parser-cannot-check disease, and
the most expensive: the other eleven stop one stage, this one poisons every stage
behind it.

On NMGB-2814 `rc-plan` did everything its intent asked and more — read the ticket
over MCP, ran the repository's own `Get-JiraAttachment.ps1 -Download`, unzipped the
workbook, **wrote its own xlsx parser** because none existed, pulled the pyramid box
labels out of `xl/drawings/drawing3.xml` by regex, read four mock-ups, and produced a
429-line plan naming the report it was matching. It then closed with eleven items
under `## Open questions / risks` and said in its own report that they *"need a human
answer before stage 3/4 proceed"*.

The stage settled `passed`. `rc-implement-sql` started eleven minutes later and each
question was answered by a guess; eighteen corrections and amendments followed. One
of the unanswered items — *"a candidate for the same DAR/consistency style
pre-aggregation … rather than a live ad hoc query"* — **is the performance problem
the report shipped with**, predicted in writing two days earlier and discarded.

Worth separating from a model-quality question, because that is what it looked like
first. The planning stages are declared `model: sonnet` in that project's routes (90
of 169 stages are), so the obvious reading was that the cheap model wrote a weak
plan. It did not: Sonnet found the ambiguity, stated it precisely, and was ignored.
Reaching for a bigger model would have paid more for the same discard. **A stage
correctly identifying what it does not know is worth nothing if nothing reads it.**

- **The mirror of `planFile`.** That holds a stage to a plan somebody else wrote;
  this holds the author to having finished it. Same worktree read, same placeholder
  substitution — the path carries the branch.
- **Declared, never inferred** from the stage kind or from `pathsWritten`. A planning
  stage does not necessarily produce a document a later stage reads, and inference
  from written paths was unavailable anyway: `rc-plan` wrote its plan with a shell
  heredoc, so `SubtaskActivity.pathsWritten` was **empty**. A check that silently
  does not fire is the failure the unquoted hook command taught this codebase to fear.
- **Deliberately looser than `parseReviewFindings`.** Every other check in the domain
  is narrow because a false stop teaches the operator to click past the stop that
  matters. The cost is different in kind at a planning gate: the operator is standing
  there with the plan open anyway, so a false positive costs one click where a missed
  question costs a stage per guess. That asymmetry is what licenses matching an inline
  phrase and not only a heading — three of that plan's questions were raised mid-step,
  which is better writing and would otherwise be invisible.
- **A missing plan is not held here**, since `changedNothing` and the stage's own
  report already speak to a planning stage that produced nothing, and holding twice
  for one fact gives the operator two stops to clear.
- Guarded on `isNothingReported` (its fourth caller), plus the **negated head noun** —
  "No open questions" is a count of none, which `isNothingReported` reads as a subject.
  Guarded locally rather than by widening it, because `parseDeferrals` and
  `parseReviewFindings` depend on it and a change there to settle a plan would change
  what stops a deployment.

### Documents a stage went and found

`domain/discoveredDocuments.ts` + `TaskReference.origin`, the same day and the same
failure seen from the other end. **Twenty-two of that stage's fifty-four commands
were spent getting hold of documents, and none of it survived the session.**
`references` was empty, so the eight stages behind it were told about no documents at
all — each a cold session facing the same twenty-two commands, or, far more often,
not bothering and using a neighbouring feature as the template. Which is precisely
what `taskReferences` was built to prevent, arriving through the one door it left
open: the operator had not named the document, and the stage that found it had
nowhere to put it.

Recording it passes `StageContext`'s own test — *eliminate deterministic facts that
are expensive or risky to rediscover*. Where an attachment landed on disk is
deterministic, cost real commands to establish once, and no cold session can derive it.

- **Two tiers, because authority is not availability.** `taskReferences` says a
  reference is "named, never inferred", since a guessed one is stated to every stage
  with the authority of one the operator chose. That rule survives intact: nothing
  scans, every path is one a stage actually **opened**, and `referenceGuidance` states
  a discovered entry as *available rather than authoritative* under its own heading.
- **An operator entry is never overwritten.** Their `note` is the part carrying the
  real information — "tab 3 of the wireframe" — and a bare discovered path cannot
  reproduce it, so overwriting would trade the one thing this cannot supply for a fact
  already held. It also stops a stage re-reading a document from churning the list.
- **Keyed on extension, not location.** The attachments landed in the **main
  repository root**, not the worktree and not a documents folder, so any rule keyed on
  where a file sits would have missed every one of them. No source file here carries
  those extensions. `.md` and `.json` are excluded deliberately: a repository is full
  of both, and a reference list nobody trusts is one nobody reads.
- **Read from `pathsRead`, not from the commands.** A document is established as
  relevant by having been opened, not downloaded — a stage that fetched five
  attachments and read one has said which mattered. The commands supply only the
  ticket key, which is what makes the note useful.
- **Recorded on the task, not the pipeline**, so it survives a revert that discards
  the stage that found it. A document belongs to the work, not to one run.

**Not fixed, and adjacent:** the attachments were downloaded into the *main repository
root* rather than a scratch directory, and `rc-plan` wrote its plan with a heredoc so
the harness recorded no `pathsWritten` for it at all — which is also why
`changedNothing` could never have caught this. Both are project-tooling questions, not
runtime ones.

### The stage that did nothing, and said so only in prose

Every defence above depends on the model emitting a marker: `BLOCKED`, `DEFERRED`,
`CORRECTION-DECLINED`, a plan step accounted `not done`. Each closed a real hole, and
each shares one weakness — a stage that declines in prose is recorded as done, because a
session ending tidily is all `finishSubtask(..., "done")` observes. Five widenings later
the sixth case still passed: a stage traced a scorecard defect to the aggregation grain
of a shared core proc, concluded the fix was a product decision out of scope for its
route, wrote "Why I stopped", and the route advanced onto stages assuming a fix that did
not exist.

Two answers, and only the second needs no cooperation:

- **`BLOCKED` now covers "should not", not only "could not".** The instruction enumerated
  *a prerequisite is missing, an earlier stage's output never arrived, the thing you were
  told to act on does not exist* — every item about being unable to start. A stage that
  is perfectly able and declines on scope or authority reads that list, correctly
  concludes it does not qualify, and writes prose. The instruction produced exactly the
  behaviour it described and still lost the signal, because the list was narrower than
  the situation. It also now says to **ask first**: a refusal turning on one product
  question is a sentence through `ask_user`, which returns into the same session, against
  a whole stage thrown away.
- **`domain/stageProductivity.ts` — an implementation stage that wrote no files is
  held.** Derived from `pathsWritten`, so it holds whatever the reply says. Narrow in
  four ways, each load-bearing: implementation stages only (a review, a deployment and an
  assessment all legitimately write nothing, and a check that fires constantly is one
  people approve through without reading); **held, never failed** (there is nothing to
  change here is a legitimate outcome); **absence of an activity record means unmeasured,
  not zero**, the same rule `stageUsage` follows; and a **declared `verify` that exited 0
  outranks it entirely**, because this is a substitute for `selfReported` evidence and
  something other than the agent has certified the work.

### A failure that was never the stage's

`domain/transientFailure.ts` + `taskWorkspaces.transientRetryAttempts`, 24 Aug 2026.
Every failing path recorded the same thing — `finishSubtask(..., "failed")`, which fails
the whole stage — so an API returning 529 was indistinguishable from a stage that got
the work wrong. `nextAction` then reports `blocked`, and **the only command that could
move a failed stage was `revertToStage`**, which discards the stage and everything after
it. An outage cost exactly what a wrong approach costs.

Worst on a correction run, which is where it was found. `correctStage` exists because a
cold re-run cost $12.48 and 44 minutes to change a type, and its whole mechanism is
*keeping* what the stage already produced; a transport error was throwing that saving
away for a reason that was never about the work.

- **Reverted, never judged**, the rule a stop and a `NEEDS-INFO` already follow: nothing
  has been decided about the subtask, so the route resumes from it. No intervention is
  counted — `revertSubtask` records one only when given a clock, and a retry the harness
  performs is not supervision.
- **Held when the retries run out, never failed.** The stage has not been judged and
  there is nothing in its account to read, so what it needs is another advance once the
  API is back — not the discard a failed stage's only remedy would demand. Reuses
  `recordStageBlocked`, so no new mechanism.
- **Anything unrecognised is the stage's.** Only a reason positively identified as the
  transport's earns a retry, which keeps every existing failure behaving exactly as it
  did. Keyed on the shapes an API error has — a status code beside a recognised name, a
  named network condition — never on a word like "overloaded", which a stage could
  legitimately write about a database.
- **A limit no backoff reaches the other side of is not transient**, checked first. A
  plan or credit limit arrives wearing 429's clothes, and retrying would spend the
  budget discovering that and then report the wrong reason.
- **The budget is in memory, not on the pipeline.** It exists to stop one advance looping
  forever on an outage; a reload or a fresh Advance Route is a human deciding to try
  again and should get a fresh budget rather than inherit an exhausted one from a state
  file written an hour ago. Nothing about the work is held there, so nothing is lost
  with it. Jittered backoff, because several tasks advancing at once fail on the *same*
  overload and would otherwise retry in lockstep, arriving together exactly when
  capacity is thinnest.

**`retryStage` had existed in `pipelineEngine` since the engine gained a `failed`
status, and was called from nowhere** — no command, no menu entry. So every failure with
a re-runnable cause (a timeout, an MCP server that was down and is now up) also cost a
discard. **Retry This Stage** wires it, on `stage-failed` only. It asks for no reason,
unlike a re-run: a re-run asks because it is discarding a run whose account of itself
goes with it, and nothing is discarded here. One correctness rule came with it — a
splittable stage is emptied so it goes back through `planStage`, *except* when it carries
a correction: a stage that failed after being corrected did not fail because its split
was wrong, and emptying it would destroy the retained rounds this whole change exists to
protect. Nor are finished units re-opened — a stage fails as soon as any subtask does, so
its siblings are routinely `done`, and on a corrected stage those are exactly the rounds
being preserved. Their replies survived a retry either way; what changes is that they are
not paid for a second time.

**And the error text was being read as a review finding** (`findingsOfSubtasks`). When a
session dies mid-turn the CLI's own account of it is the last thing in the transcript, so
the reply persisted for that subtask is the error — and `inlineSeverity` reads
`API Error: 529 Overloaded` as a label introducing a critical. The report opened on
"Findings — 1 critical", the critical being the outage, and the tree row said the same.
Eleventh false stop of that family and the third to arrive through the *label*; closed by
the rule the handoff already follows — a failed stage's conclusion is not a conclusion —
applied per subtask, so the surviving rounds of a corrected stage keep their findings.

### Two ways a stopped stage looked like a running one

Both found on 24 Aug 2026, from one failure: `winget upgrade --all` moved Claude Code from
the npm shim to the native installer, which wrote its PATH entry at **machine** scope as
the literal `%USERPROFILE%\.local\bin` — expanded in the system context, so every process
on the box got `C:\windows\system32\config\systemprofile\.local\bin` and the real
`claude.exe` was on no PATH at all. Not a harness bug, but it exercised two.

**A stage holding a failed subtask spun in blue** (`stagePresentation`). `finishSubtask`
fails a *stage* only once every subtask has resolved — right for judging the stage — and
the driver stops at the first failure rather than spending sessions on siblings whose plan
is probably wrong. So the commonest shape of a failed stage is `active` with one failed
subtask and the rest pending, and the row said **In progress** on a route that had
stopped, with the reason nowhere on it. Worse, `stage-active` is not what
**Retry This Stage** is keyed on, so the one command that could move it was not offered —
the fix shipped that morning was unreachable in exactly the case it was written for. Keyed
on a failed subtask rather than on "nothing is active": a subtask reverted by a question or
a held call leaves the same shape while the route is legitimately waiting (`stageBlock`
presents those), and a failure is terminal, so there is no window mid-advance where this
misreads a stage between subtasks.

**And the command was spawned unquoted** (`commandForShell`). `claudeCommand` is routinely
an absolute path once the CLI is not on PATH, and a Windows profile name with a space in it
is ordinary — so the spawn failed as `'C:\Users\Conor' is not recognized`, which reads as
the CLI being missing rather than as the path having been cut in half. **The rule is the
opposite of the permission-gate hook's**, which is why it is recorded rather than copied.
Probed through node's `spawn(..., { shell: true })` on CLI 2.1.223:

| command | resolves |
|---|---|
| `claude` | yes |
| `"claude"` | **no** |
| an absolute path containing a space | **no** |
| the same path, quoted | yes |

cmd resolves a bare name against PATH and PATHEXT and looks for a quoted one literally, so
quoting unconditionally — the hook's rule, where a silent failure is indistinguishable from
the feature being off — would break the default here. Quote on whitespace, and what makes
that a measurement rather than a guess is that both arms were run.

### Work that belongs to no stage

Every stage is told to stay within its objective and say so rather than reach
outside it. That instruction is right, but the saying-so was prose at the end of a
reply and **nothing read it** — so work belonging to *no* stage was declined by
each stage in turn and discovered where it finally bit: a live publish that halted
on a data structure nobody had created, several stages after the first agent
noticed it was missing.

- A stage now declines work as `DEFERRED: <what>` (`stagePrompts.ts`), parsed and
  stripped like `VERDICT` and `HANDOFF`. Read from the report half of the reply
  only, so a handoff *describing* a decline is not counted as a second one.
- `recordDeferrals`/`outstandingDeferrals`/`resolveDeferral` (`pipelineEngine.ts`)
  hold them on the pipeline, deduplicated per stage — a split stage's subtasks each
  run cold and each notice the same gap.
- **`nextAction` holds in front of a `deployment` stage** while any is
  unsettled, returning `deferredWork`. Only a stage that ships: most deferrals are
  correct and harmless, and holding every stage on one is how a safety net gets
  switched off.
- **Settled at the raising stage's own approval gate**, as well as at the hold. The
  hold stays in front of a shipping stage — that part was right — but for a while
  that hold was also the only *place* to settle, so a real run accumulated declines
  from 08:40 onward and asked twelve questions at once immediately before a DEV push,
  about stages read and approved hours earlier. Every one had passed a gate where the
  operator was already standing with the report open. `approveStage` now asks for each
  of that stage's own outstanding items; escape leaves one outstanding rather than
  abandoning the approval, which is already decided by then.
- **A stage answering "nothing" is not a report of anything** (`domain/nothingReported.ts`,
  shared by `parseDeferrals` and `parseReviewFindings`). The same bug appeared three
  times in one morning: `DEFERRED: none — this is Nissan GB only…` held a deployment;
  `**Important**` / `- none` and `**Critical**` / `- resolved` each blocked their own
  review. Every one is a stage saying everything is fine and stopping the route —
  the worst direction for a false positive, because the correct response looks like
  the harness malfunctioning and teaches people to click past the stop that matters.
  Two vocabularies with different guards: *absent* words fail as subjects ("none of the
  migrations carry a USE statement"), *settled* words fail as adjectives ("fixed width
  column overflows"). Narrow in both directions — dropping a real finding is worse.
- **A severity label can be a count of none** (`NEGATED_COUNT`, 19 Aug 2026). Eighth false
  stop of this family and the first to arrive through the *label* rather than the finding
  text, so `isNothingReported` never saw it: by the time it runs the label has been
  stripped and what remains is a real sentence about real work. A planning stage closed
  with "No blocking or deferred items — all findings from the prior review rounds were
  already addressed…", which `inlineSeverity` read as a 29-character all-letters label
  containing "blocking", and the sentence after the dash as the critical it introduced.
  One critical on screen, saying in as many words that nothing was outstanding. Keyed on
  the **head noun**, never on the negator: refusing every negated label would drop "No
  error handling — the loop swallows exceptions", and dropping a real finding is the
  worse error in every other rule in that file.
- **A severity label is not a sentence about findings** (`startsLikeSentence`, 19 Aug 2026).
  Ninth false stop, and the second in a day through the label. A DEV deployment preview
  opened "The two critical items the finding names — …were both already resolved by the
  time this stage ran"; `inlineSeverity` read the 39 characters before the first dash as
  a label — letters and spaces only, inside the length cap, containing "critical" — and
  the paragraph after it as the critical that label introduced. A marker names a
  severity and never opens with an article, a demonstrative or a possessive. A
  **leading-word test rather than a tighter cap**, because the label here was already
  inside the cap and a cap short enough to exclude a seven-word sentence excludes real
  markers too. Applied to the inline path and to a heading carrying its own summary,
  never to a bare heading: refusing "## Critical issues" would clear the severity for
  every item under it.
- **A finding whose author says they are not blocking on it is a suggestion**, whatever
  heading it was filed under. Same principle as a stated `VERDICT` outranking inferred
  severities: the heading is chosen once at the top, the sentence is the reviewer ruling
  on that item having done the work. Downgraded, never dropped — "watch the execution
  time on the first live run" must survive to the report.
- **`DEFERRED` is only for work no stage owns**, which is what the engine always meant
  by it. A stage that can name the owning stage says so in its report and moves on: the
  marker holds the route until a human writes a sentence about ownership, and asking
  that when the stage has just established the route owns it is pure noise. A real task
  reached **40 declined items, 27 of them four observations** reworded by each stage
  that noticed them, every one naming the stage that already owned it. Where no stage
  owns it, the stage **asks** — at the moment it finds the gap, with the context that
  found it, at the cheapest point the work could simply be done — and only falls back to
  the marker if it cannot ask.
- **An item that names its own owner is settled on sight** (`domain/deferralOwnership.ts`).
  `DEFERRED` means work no stage owns; the prompt says so, and nothing checked it. A DEV
  preview declined "actually deploying these 3 files to DEV" while naming the
  `Deploy to DEV` stage in the same sentence — a stage the pipeline lists as pending two
  rows below — so settling it asked a human who owns work whose owner was quoted in the
  item. Recorded, never dropped: the marker line is stripped from the report, so the item
  is the only place the observation survives. Deliberately narrow — the name must be
  quoted or sit beside the word "stage", because auto-settling a genuinely ownerless item
  is the failure the whole mechanism exists to prevent, while a redundant one costs a
  sentence.
- **Deduplicated on a normalised key, across every stage** (`deferralKey`). The item is
  the work; it does not become different work because another stage noticed it or a
  re-run reworded it. Backticks, parentheticals, digits and everything after an em-dash
  are dropped — that tail is the stage's guess at an owner, and two stages guessing
  differently about one item is not two items. Deliberately *not* fuzzy matching:
  merging two real items is worse than listing one twice.
- **Discarding a run settles what it declined** (`settleDiscardedDeferrals`). The half of
  the re-open rule that was only ever asserted: re-opening a stage clears its checklist
  and plan steps because they belong to a run that no longer exists, and the same
  sentence claimed deferrals were "ignored, exactly as that stage's checklist items are
  discarded". They were not. `outstandingDeferrals` merely *hid* them while the raising
  stage was pending, so they returned the moment it passed again — a real task corrected
  a stage, watched the four stages after it re-run and pass, and found the same fourteen
  items waiting, every one raised by a run that had been thrown away. Settled rather than
  deleted, which is what `DeferralItem` says about itself; anything still true is raised
  afresh by the re-run, which is what makes discarding safe.
- Settling one **requires a sentence**, not a tick. What was missing when every
  stage declined the work was the knowledge of who owns it, so silence would
  reproduce the gap. Items raised by a re-opened stage are ignored, exactly as
  that stage's checklist items are discarded.
- **The item is a question's label, not the record** (`domain/deferralText.ts`). The
  settlement box is a single-line input with the item as its prompt, so a stage that
  wrote a paragraph turns "who owns this?" into five lines of argument to read first —
  and the answer is usually already known. `deferralHeadline` shows the first sentence,
  capped, and says where the rest is; truncating is only safe *because* the full text
  is in the stage report, which is why the prompt and the skill now ask for the **work,
  not the argument** — under about twenty words, evidence in the report where there is
  room for it.

### Work a stage was told to do and didn't

The same disease as deferrals, one step further in: a stage executing a written plan
self-reported one outcome for the whole document, so a numbered step it skipped in
silence was indistinguishable from one it completed. One such step — a post-deploy data
rebuild — reached production as a scorecard reading 0.0%.

- `domain/planSteps.ts` — parses a plan's numbered steps and the `STEP <n>: done|not
  done — …` lines a stage answers with. **Step identity comes from the file**: the plan
  is written by one cold session and executed by another, so nothing held in a session
  can identify a step. Headings win over list items when a document has both, or a plan
  whose steps each contain a numbered sub-list would demand an account per sub-bullet.
- A route stage declares `planFile` (relative to the **worktree** — unlike `verify`,
  the plan is this task's work product, not project config). The runner reads it before
  the session, and a stage whose plan is missing is **not run**: improvising from the
  brief and reporting done is the state this exists to prevent.
- A step reported *not done* becomes a **deferral**, reusing the hold in front of a
  shipping stage and the settlement that requires a sentence. It is the same fact by a
  different route. A step **nobody mentions** holds the stage, and `approveStage`
  refuses it — silence is the failure mode, so silence is what cannot pass.
- `${taskName}`/`${branch}`/`${baseBranch}`/`${worktreePath}` in a `verify` command are
  substituted (`domain/commandPlaceholders.ts`); anything else in `${...}` reaches the
  shell verbatim, because that is real syntax in both shells. A check that cannot name
  its own ticket degrades into an existence check, which passes in the one case that
  matters.

### Half a stage's prefix was tools it never calls

`domain/stageTools.ts` + `--tools` in `claudeCliArgs.ts`, 17 Aug 2026. Measured on CLI
2.1.223: a stage session's cached prefix is **31,577 tokens before it is told anything
about the task**, and about **15,000 of those are schemas for built-in tools no stage has
ever invoked** — web search, web fetch, notebook editing, the rest of Claude Code's
general-purpose surface. Declaring only the tools stages actually use halves it.

| tools declared | prefix tokens |
|---|---|
| all (the CLI default) | 31,577 |
| the measured stage set | **16,695** |
| a six-tool guess | 7,764 |
| none at all | 3,511 |

**The list is measured, and guessing it broke things.** Every entry comes from
`SubtaskActivity.toolCounts` across 160 real sessions — which is exactly why activity is
recorded verbatim. The first list written from intuition (Bash, Read, Write, Edit, Glob,
Grep) saved *more*, 75%, and would have silently removed three load-bearing tools:
`Skill` (31% of sessions — how the protocol skill loads), `Agent` (7% — the delegation
`subagentLimits` exists to *govern* rather than remove), and `ToolSearch` (14%). A
cheaper prefix that costs a stage its protocol is not a saving.

Four rules, and the first is the one that makes it admissible at all:

- **Stage sessions only.** A hand-driven chat declares nothing and keeps the CLI's full
  set. Narrowing a person's tools to the set stages happen to use would be the runtime
  deciding what a human may do — the same line the permission gate and the protocol skill
  already draw.
- **A whole-set declaration, not a subtraction.** `--disallowed-tools` removes named
  tools from whatever the default happens to be, so a tool added by a future CLI release
  enters every stage session unannounced. `--tools` states the set.
- **Removal, not refusal** — the argument `subagentLimits` and the scan runner already
  make. An agent that never had a tool does the work with what it has; an agent whose
  call is refused spends turns discovering the wall.
- **Widened from configuration** (`additionalStageTools`), because a route that needs a
  tool nobody has needed yet must not need a new build — and emptying the setting
  restores the CLI's own default rather than breaking a stage.

**Two flags that sounded relevant and are not**, both probed: `--strict-mcp-config`
changes the prefix by **1 token**, and `--exclude-dynamic-system-prompt-sections` by
**115** — it targets cross-*user* cache reuse, which a single-operator harness does not
have. Only `--tools` matters.

**What this is and is not worth.** In steady state roughly $0.03–0.06 per session — real
but not transformative, since 25k of the old prefix was cache-*read* at $0.50/M rather
than created. The stronger case is the one that has nothing to do with billing: 15k
tokens per session describing capabilities that do not exist in the harness's model of a
stage, and a stage's permitted surface being Claude Code's default rather than the
harness's declaration. That is the cost half of the deferred stage-isolation work, which
had been filed as "not a usage measure" on a narrower measurement.

**Requested capability versus enforced capability.** A community report on 23 Aug 2026 had
custom agents declared read-only in `.claude/agents/*.md` writing files anyway — so a role
declaration is not a boundary. It does not reach this harness, which reads no agent
frontmatter at all, but it prompted the question of whether `--tools` is enforcement or
advertisement. **Probed, CLI 2.1.223, three arms:**

| declared | permission mode | advertised | write attempted | filesystem |
|---|---|---|---|---|
| `Read Grep Glob` | `acceptEdits` | `Glob,Grep,Read` | no | unchanged |
| `Read Write` *(control)* | `acceptEdits` | — | yes | **written** |
| `Read Grep Glob` | `bypassPermissions` | `Glob,Grep,Read` | no | unchanged |

The third arm is the answer. The session was told it was authorised and that the tools
were available despite not being listed, given three separate write paths (`Write`,
`echo >`, `node -e writeFileSync`) and told not to stop at the first failure — and run
under `bypassPermissions`, so the permission layer was not what stopped it.
`permission_denials` is **empty** in both read-only arms: nothing was refused because
nothing was ever emitted. The tool has no schema in the request, so there is no call for
the model to make. Enforcement is structural, which is the *removal, not refusal*
property `subagentLimits` and the scan runner already depend on, now confirmed against a
session trying to defeat it. The control arm is what makes the nulls admissible rather
than a broken rig.

**What it does not establish, and the distinction is the load-bearing part.** What is
enforced is the *tool surface* and subagent depth. Writable paths, processes and network
surface are not — and `Bash` is in the measured stage set, so a real stage can write
anywhere its process can. `--tools` proves the declared set is the effective set; it says
nothing about a stage being read-only. So a role is a *request* the engineering layer
makes and the tool set is what the runtime *enforces*, and the two must never be read as
the same claim.

Closing the rest would need a filesystem or process boundary, **not** a gate policy.
`permissionGatePolicy` passes by default and holds only what the CLI has already refused,
because any `permissionDecision` overrides the CLI's own classifier — so a general
`allowedPaths` makes the gate the command-safety adjudicator it exists not to be. The two
rules that do fire pass a narrower test: `credentialExposure` and `stagedEnvironmentPaths`
each ask about the runtime's own state — does this write a secret into a file the harness
persists, does this commit a path the project itself declared is not work — never whether
a command is dangerous.

### The stage environment, and what it cannot start without

Two checks that both exist because the failure they prevent is a stage *succeeding*.

- **Required MCP servers** (`domain/mcpReadiness.ts`, `RouteStageDefinition.requiredMcpServers`).
  The CLI connects `--mcp-config` servers before the first turn and reports the outcome
  on its init event — statuses in `mcp_servers`, and separately the config entries it
  rejected in `mcp_server_errors`, which appear in no status list. A stage declaring
  servers is abandoned at that event if any is unavailable: before inference, so the
  cost is startup time only. Declared **per stage**, because failing every stage on an
  unrelated broken entry is how a check like this gets switched off. What it prevents is
  not an error — an agent denied its ticket tooling does not stop, it substitutes a
  plausible guess at the ticket and reports done.
- **Subagent limits** (`domain/subagentLimits.ts`). `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
  and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, set on stage processes only. The harness
  owns concurrency at the *task* level; left at the CLI's defaults one stage's fan-out
  starves the other tasks of a machine and a rate limit they share, and the loss reads as
  "everything was slow today". Zero is clamped to one — the CLI treats zero as unset,
  which is the opposite of what setting zero meant. **Depth counts levels of subagent
  below the stage session, probed on CLI 2.1.223:** at `1` a stage delegates normally
  and its subagents have no Agent tool; at `3` they do and nesting works. So `1` is
  "delegation, no trees", not "no delegation" — the two readings differ by one, and the
  wrong one switches subagents off silently. Enforced by removing the tool rather than
  refusing the call, which is the better failure: an agent that never had a tool does
  the work itself instead of spending turns rewording a request it cannot make.

### The compatibility probe backlog

Every CLI fact above is a *result*, recorded so it is not re-derived. This is the other
half: what is **not yet probed**. The validated baseline is **CLI 2.1.223** — everything
asserted above holds there and nowhere else has been checked. Each item below is a
behaviour a later release changed or introduced that can alter stage execution *without
failing*, which is the only kind worth the startup cost of a probe. Run them when the
baseline is next promoted, not before; a probe against a version no stage runs answers
nothing.

- **Managed MCP collision surface** (2.1.229). `managed-mcp.json` and server-delivered
  MCP now resolve by precedence, the loser being skipped with a *warning* rather than
  killing the session. `mcpReadiness` reads the init event and deliberately does not
  reconstruct precedence — but it was written against two config sources and there are
  now three, so the question is where a skipped-by-precedence server appears: a status in
  `mcp_servers`, an entry in `mcp_server_errors`, or only a warning in neither. A required
  server silently absent from both lists reads as ready, which is the exact failure the
  check exists to prevent. The most valuable of these by some distance.
- **`Write` may overwrite an unread file, on newer models only** (2.1.228). The one item
  that changes tool semantics rather than architecture: same stage, same file, different
  model, different admissible action. Probe is cheap and deterministic — existing file,
  fresh session, ask for an overwrite with no read, record allowed/rejected against CLI
  version *and* `actualModel`. Do **not** compensate by forcing a read in the harness:
  that puts execution-engine policy into orchestration. Recording it is the whole
  response, and `SubtaskActivity.actualModel` already exists for it.
- **Server-supplied hooks reach self-hosted runners** (2.1.229). The permission gate
  assumes the hooks a stage runs under are harness-owned and one-directional. If policy
  can arrive from outside both the repository and our settings file, then *stage config +
  local config = complete execution policy* is false. Probe the observable question only:
  can a stage detect headlessly that a hook it did not install is in effect? Nothing to
  build until it can — an `enginePolicy.source` field with no deterministic way to
  populate it is a configuration abstraction pretending to be evidence.
- **Plugin `command` source** (2.1.229). A marketplace may resolve its plugin directory
  by running a local command, re-resolved per session, with `mode: "link"` usable without
  a restart. Potentially a cleaner protocol-skill deployment than `--plugin-dir` at a
  fixed absolute path. Probe: does it behave deterministically under `-p` and
  stream-json, from an untrusted worktree, resolving once per fresh stage session? Until
  all three hold, the existing static path is the safer known behaviour.

**Cache staggering is remembered, not queued** (2.1.229, `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`).
Anthropic staggers sibling workflow agents so later ones hit the prompt cache instead of
each paying to create the same prefix — a concrete case of *less* concurrency costing
less. It is not a probe item because its precondition is one this architecture works
against: every subtask is a cold session with its own brief, so there may be no shared
cacheable prefix to reuse. Concurrent stages are also blocked for unrelated reasons —
five modules keyed by task id, not subtask (see the latency measurement below). Prove the
shared prefix before benchmarking a staggerer, or it is measurement infrastructure
looking for a decision.

### Measuring the thing the harness is actually for

- **`domain/interventions.ts`** — every moment a human had to act, as events on the
  pipeline. The only measure of throughput-per-engineer that does not fall out of
  existing state: cost, tokens and latency are all derivable, but approving, answering,
  granting a permission and settling a deferral are four records in four places and
  nothing summed them. Kept per kind and per stage, because "twelve interventions" does
  not distinguish a route that asks too many questions from one that fails too often,
  and those have opposite fixes. **Timestamps are passed in, and a call site with no
  clock records nothing** — which is also what keeps the runner's own automatic reverts
  out of the count. A retry the harness performs is not supervision.
- **`SubtaskActivity.actualModel`** — what the CLI resolved, not what was asked for. A
  model an org policy disallows is substituted without failing, so a cost comparison
  keyed on the requested name compares two runs of the same model. `UsageTotals.models`
  carries the distinct set; two entries where a stage asked for one is the tell.
- **`ask_user` time was being counted as the model working** (`domain/humanWait.ts`,
  `SubtaskActivity.blockedOnHumanMs`, `UsageTotals.blockedOnHumanMs` + `workingMs`).
  The tool returns its answer into the waiting turn — the whole reason it beats
  `NEEDS-INFO` — so the operator's thinking time sits inside the subtask's own
  `startedAt`/`finishedAt` span. Nothing separated them, which made the harness's own
  KPI unmeasurable in the direction that flatters it: the first real latency
  measurement of a route reported **4% idle**, concluded it was not
  supervision-bound, and sent the effort at execution — while its 32-minute
  implementation stage had called `ask_user` twice. `AskUserService` keeps a
  cumulative per-task tally and the runner samples it either side of each session,
  keeping the difference, exactly as it snapshots the worktree list around a stage
  that may create one. Three rules: the tally **survives `release`**, because
  `release` runs inside `StageSessionRunner.run` *before* the runner's closing
  reading and clearing it there would make the difference negative; an **abandoned**
  wait counts, or a stopped task looks like its stages ran fast; and **absence means
  unmeasured, not zero**, so the wait is reported beside the elapsed time rather than
  only subtracted from it.

### The UI's own latency, which is a different problem entirely

Measured 14 Aug 2026 on a repository with nine tasks, after "the whole UI is slow again".
Recorded because every part of the guess was wrong, and because the numbers point at
*coalescing* rather than at anything being individually slow.

| what | cost |
|---|---|
| one tree render (9 tasks) | **401ms** — 18 concurrent git spawns |
| one `git status --porcelain` on a worktree | 250–280ms |
| `git worktree list` | 64ms |
| state file read + parse (3.09MB) | 7ms + 6ms |
| `for-each-ref` for the branch picker | 59ms |

**The state file is not the bottleneck**, which is worth knowing before anyone optimises it
— 13ms to read and parse 3MB, against 400ms of git. (235KB of one task is
`activity.output`; that is what makes it 3MB, and it costs almost nothing to load.)

The defect was that **nothing coalesced**. `refresh()` fired the tree's emitter
immediately, from around forty call sites plus every session status change, and there was
no debounce anywhere in the codebase — so a running route turned a burst of events into
overlapping 400ms git storms. The cost lands on the extension host, which is why the
symptom was never confined to the tree: the base-branch picker's 110ms of git read as
"ages" because it queued behind renders nobody asked for. A slow-feeling UI here is
contention, not a slow path.

`utilities/renderThrottle.ts` + `MIN_RENDER_INTERVAL_MS`, and three rules each with a
failure behind it: **trailing edge**, because leading-edge drops what arrives during the
window and the last state of a burst is the one worth showing; **the first render after a
quiet period is not delayed**, or the throttle adds the lag it exists to remove; and
**`refresh()` drops the memo before requesting a render**, because a command that has just
changed something must never be shown a row computed before its change. A deliberate
action — the Refresh button, the archived toggle — calls `refreshNow()` and skips the
interval, since a button that waits out a throttle reads as broken.

Also **single-flight on the root render**: VS Code asks for the root more than once per
redraw, and each ask used to start its own 18 spawns.

Not yet done, and both measured rather than suspected: `ReportContentProvider`'s 2s timer
re-reads and re-parses the whole state file per open report, from activation, forever
(~15ms each, permanent); and a first render still costs its 400ms, which only a two-phase
render — rows now, live state filled in after — would fix.

### The second latency measurement, and the denominator the first one missed

Taken 14 Aug 2026 across all eight live pipelines in `qubeautoapp`'s state file, after
"latency is becoming a real problem". The first measurement concluded a route is
generation-bound and sent the fixes at project config. It was right about the arithmetic
and wrong about the question, because it measured **surviving** subtasks only:

| | time | cost |
|---|---|---|
| surviving execution | 382 min | $127 |
| discarded execution | **824 min** | **$252** |

**68% of all agent execution was thrown away.** Throughput is 42.5 tok/s against the
40 tok/s measured three days earlier, so nothing got slower; what grew is how much of it
gets discarded. `TaskPipeline.discarded` was added *because* that blindness was noticed,
and then nobody re-read the number.

**The "downstream stages are cheap" assumption is false.** Unconditional re-opening was
justified on the grounds that implementation carries nearly all the cost and the rest are
gates. Measured: non-implementation rework is **120 runs, 423 min, $107** —
`deployment` 179 min, `domainReview` 101 min, `codeReview` 71 min, `test` 61 min. Gates
are free; the stages between them are not.

**Where the corrections actually come from**, read from 25 correction findings and ~40
guidance notes:

- **The worst single stage was a harness bug already fixed.** `Promote to UAT`, 8 runs,
  135 min — its own re-run reasons say the verification ran a stale copy of
  `Test-WorkPromoted.ps1`. That is the `${repoRoot}` defect, and the project's routes now
  use the placeholder throughout. Discount it before reading the rest.
- **A governing document existed and no stage was pointed at it** — the largest remaining
  cluster, and the subject of `domain/taskReferences.ts` below.
- **The operator was conducting a conversation by re-running a stage per question** —
  `Decide and make the change`, 6 runs, 37 min, three questions. See
  `domain/stageInterjection.ts`.
- **A fix reported but not landed** — "purchases still double-counted (NOT fixed)", found
  by the same review twice. The sixth instance of the reply-claims-an-outcome-the-parser-
  cannot-check disease.
- **A change applied to one object and not its twin** — `p_Bespoke_Scorecard_Summary`,
  the `PartMultiplier` baselines.

### Telling a stage what governs the work

`domain/taskReferences.ts` + `TaskWorkspace.references` + `StageContext.references`,
built 14 Aug 2026. The measured failure: a report's layout came from tab 3 of a wireframe
spreadsheet, the stage built it from the nearest prior implementation instead, and it cost
five corrections — hitting `Plan` and `Implement the data` *separately*, because
subtask-per-session means each stage rediscovers the gap rather than inheriting the fix.

The stage was not being careless. Told nothing about what governs the work, a capable
model does the reasonable thing and copies the closest existing feature, and **it cannot
detect that it has done so**. Which document decides the work is exactly what
`StageContext` is for: a deterministic fact the operator holds that is in no diff, no
branch and usually not in the brief.

Rules, each load-bearing:

- **Named, never inferred.** No scan of the repository for likely-looking documents. A
  guessed reference would be stated to every stage with the authority of one the operator
  chose, and being told the wrong document is authoritative is the failure this prevents.
- **Precedence is stated, not implied.** The prompt says the document decides behaviour,
  layout and naming and the code is a guide to style only — because a stage given both and
  no ranking simply merges them, which is how one report ended up with Phase 2's layout and
  this task's data.
- **A document it cannot open is a thing to ask about.** Governing documents are routinely
  binaries or wiki pages, and what a stage does when it cannot see the spec is the whole
  defect. Existence is deliberately not validated, or the references that caused the
  failure would be the ones refused.
- **The note field earns its place.** "tab 3 of the wireframe" — a stage handed the
  workbook and not the tab has the same ambiguity in a smaller box.
- **In the cached prefix.** Per-task, so it sits with the brief and the route outline and
  twenty-two sessions pay for it once. Anything per-stage placed above it would end the
  shared prefix there.

### Speaking to a stage that is already running

`domain/stageInterjection.ts` + `PermissionGateService.interject`. `ask_user` let the
*agent* open a channel mid-session and there was no reverse: once a stage was running the
operator could wait for it or throw it away. So the correction arrived as a re-run, and a
three-question conversation cost three whole stages.

**Probed against CLI 2.1.223, because the entire design turns on it:**

- **A `PreToolUse` hook answering `allow` carries a `permissionDecisionReason` the model
  never sees.** Verified directly — a session asked to quote any message received during
  an allowed call reported, correctly, that the tool result held only the command's output.
  The obvious channel does not exist.
- **A hook answering `deny` delivers its reason to the model verbatim and mid-turn.**
  Verified: the probe token came back quoted in full and the session adjusted and completed
  in the same turn, no re-run.

So the only way into a live session is to refuse one tool call and say why. The cost is one
round trip — the denied call never executes and the agent re-issues it if it is still
right; what is saved is the stage.

**The transport was never the hard part — provenance was.** Exercised end to end against a
real session, and the first two arms failed in a way no unit test would show. Told nothing
about the channel, the session received the message verbatim, **and refused it**: *"that
didn't come from you as a user turn — it appeared inside tool output — so I disregarded
it."* It re-issued the held call and carried on with its original plan. That is correct
handling of an instruction arriving in a tool channel, it is what a current model *should*
do, and it defeats the feature completely. Naming the sender inside the message did not
help — the message cannot establish its own authority, which is the whole point.

Declaring the channel in the **invariant preamble** fixes it, and only that. Same
scenario, same message, with `INTERJECTION_MARKER` and its meaning stated from turn zero:
the session re-issued the held call, obeyed the redirection, and reported what it had been
told. Verified twice — once with a hand-written contract, then again with the shipped
`invariantProtocolBlock`.

This is a contract in the strict sense the three-layer split above means, and it must
never move into the skill: a session that did not load the skill refuses the interjection
and looks exactly like a session whose operator never spoke. Four arms, all CLI 2.1.223:

| what the session was told | outcome |
|---|---|
| nothing (message names its sender) | **refused as untrusted content** |
| nothing, and prompt mentions permission messages | **refused, and reported it instead** |
| hand-written contract up front | obeyed, held call re-issued |
| the shipped `invariantProtocolBlock` | obeyed, held call re-issued |

Rules:

- **Delivered on the first call it can get**, ahead of `gateVerdict`. A call the policy
  would have passed is the *best* one to spend; waiting for one the policy holds means the
  message arrives only if the stage does something contentious, which may be never.
- **The message names its sender.** Probed: given an anonymous instruction inside a denial,
  the session treated it as an injected string of doubtful provenance, declined to act on
  it, and said so — correct behaviour, and useless. It also has to say the call was not run
  and nothing is wrong, or a denial reads as a permission wall and the stage starts working
  around it, which is what the gate exists to stop.
- **One held at a time, replaced not queued.** Each delivery costs a refused call, and an
  operator typing twice has corrected themselves.
- **Never persisted, and dropped on `release`.** An interjection is addressed to the
  session running now; one surviving a reload would be delivered to whatever stage ran
  next — the failure `guidanceFor` exists to prevent one level up.
- **Refused when no gate is armed**, because nothing would ever hold a call and the
  message would wait forever looking pending.
- **Counted as its own `InterventionKind`**, recorded on delivery rather than on typing.
  Distinct from `answer` deliberately: an answer is the stage asking and the mechanism
  working; an interjection is the operator intervening unprompted because the stage was
  confidently going the wrong way and had not thought to ask. A route accumulating these is
  under-briefed, which is the opposite fix from one that asks too much.

**The one constraint:** a stage composing its final reply makes no more tool calls and
cannot be interrupted. The command says so rather than letting it look broken.

### What the stages spend their tokens on

The other half of the 14 Aug measurement, from `SubtaskActivity.commands` — recorded
verbatim, which is what makes this answerable after the fact. 1,115 commands across 134
measured subtasks. Output tokens are wall-clock time, so this is minutes:

| | commands | ~output tokens |
|---|---|---|
| commands over 400 chars, i.e. authored inline | 231 | **49,600** (~20 min) |
| redundant `cd <worktree> &&` prefixes | 682 (**61%**) | 12,100 (~5 min) |

- **The `cd` is defending against nothing.** `claudeStreamSession` sets `cwd` to the
  worktree, and the Bash tool restores it to the worktree between calls — the "shell cwd
  was reset" notice. Agents read that as a hazard and prefix `cd` into the directory they
  are already in, on three commands in five.
- **The authored shell is one idiom, over and over**: turning an environment profile into
  a database connection. 37 commands, 7 tasks, 5 stages, ~8,200 tokens of the same
  `Get-Content $envFile | ForEach-Object` block. Every session starts cold, so each
  rebuilds what the last one wrote and discarded.
- **The checked-in helpers are used and bypassed**: `Invoke-SqlQuery.ps1`/`Invoke-SqlScript.ps1`
  50 times, raw `sqlcmd` 80 times. The helper covers *running a query* and not *resolving
  a profile*, and the gap is exactly what gets rebuilt. The "replace the loop, not the
  landmarks" lesson recurring: the loop here is **connect to this environment's database**.

Both fixes went to the **skill**, not the preamble — this is execution-efficiency
guidance, the same class as the shell-versus-file-tool cost that was moved there, and
unlike a parsed marker a sometimes-load is tolerable because the failure is cost rather
than a misread reply.

**Found on the way, and not a latency problem:** 150 commands across 7 tasks carry an
inline credential (`sqlcmd -S … -P <password>`), recorded verbatim in `state.json` and
rendered into stage reports.

Two halves, and they needed different answers. The project half was that seven stages
*instructed* it — "Build the connection string directly from `tools/mcp/profiles/<Manu>.dev.env`"
— so the stages doing this were following their brief exactly; `qubeautoapp` 7fe00c7e8
points them at the tooling instead. The runtime half is `domain/credentialExposure.ts`:
the gate refuses a call that carries a secret on the command line.

Admissible where safety classification is not, and the distinction is load-bearing.
`permissionGatePolicy` refuses to replicate the CLI's "is this command safe" judgement,
because that means guessing another tool's policy and being wrong in the direction of
blocking `git status`. This asks a different question — does running it write a secret
into a file **this harness owns** — which is a fact about the runtime's own persistence
that no execution engine can know on its behalf. Four rules:

- **Denied, not held.** A hold waits for a human and an unattended stage stops; a denial
  returns into the same turn and the agent re-issues the call. A wrong refusal costs one
  round trip, a wrong allow persists a live credential.
- **Narrow, because a false positive is how a check like this gets switched off.** A bare
  `-P` is not enough — `grep -P` is a Perl regex — so the flag counts only alongside a
  named database client, and only with a value that is not itself a flag, since `-P` with
  none is the interactive form the fix produces.
- **No project knowledge in the message.** The harness may say a secret must not reach a
  command line; only a repository can say which script resolves one.
- **Command lines only, never file contents.** A stage spotted the gap the first time the
  rule ran and it is deliberate: `commands` are recorded verbatim, a write records only
  `pathsWritten`. A secret a project puts in a config file is its own business; one that
  lands in `state.json` because a stage typed it is the runtime's doing.

Verified end to end, and the first attempt proved the harness rather than the rule: gating
only `Bash`, the CLI reached for `PowerShell` and the gate never saw the call. The
extension's default set already covers both. With it, the refusal reached the agent
verbatim, it quoted the reason back, declined to route around it, and the secret never
entered the reply.

### The first latency measurement, and what it ruled out

Taken 11 Aug 2026 against a live 23-stage `report-change` route. Recorded here because
every plausible guess about harness latency was wrong, and re-deriving that costs a
morning.

**65.4 min wall clock, 62.6 min execution, 4% idle** — so not supervision-bound (with
the `ask_user` caveat above). 77% of execution was **two subtasks**. Across the route,
**151,381 output tokens over 62.6 min = 40 tok/s**, against 59–62 tok/s on the fastest
stages. Generation is serial, so at achievable throughput generation alone accounts for
~42 of the 62.6 minutes, leaving at most ~21 for *all* tool execution and *all* harness
overhead across 271 tool calls — and that residual includes real SQL against DEV and two
full solution builds.

What that rules out, and the reason each is not worth building:

- **Parallelising read-only review stages.** Worth ~3 of 65 min (4.7%) here, and it is
  not a small change: `sessions.create`, `gate.prepare` (which *empties* the ask/gate
  inbox), `gate.release`, `sessions.stop`, `liveActivities` and the `running`
  `AbortController` are **all keyed by task id, not subtask**. `AgentSessionManager.create`
  stops the task's existing session, so stage two would kill stage one, and two
  concurrent stages would wipe each other's pending questions. Re-keying five modules
  for 5% fails the test; the per-task inbox directory is load-bearing elsewhere.
- **The `PreToolUse` gate hook's per-call process spawn, MCP connection time, and cold
  session start.** Bounded small by the token arithmetic above, and unquantified —
  measure before spending. The gate passing by emitting nothing means most spawns do
  nothing, so it *looks* wasteful; the arithmetic says it cannot be more than a slice of
  the residual.

Where the time actually goes, and both fixes are **project config, not harness code**:
the SQL stage spent a large part of 71,002 output tokens authoring an ad-hoc query
harness inline — then deleted it and wrote five of its files again — and the app stage
ran two full solution builds while the `Build` stage that follows compiles in 0.6 min.
Fixed in `qubeautoapp` by checking in `Invoke-SqlQuery.ps1`, `Invoke-SqlScript.ps1`,
`Compare-QueryResults.ps1` and `Test-SqlProjectConventions.ps1` under `tools/sql/`,
naming them in seven stages' intents, and telling implementation stages not to build.
**Output tokens are wall-clock time** is the general lesson: the cheapest latency win is a
stage not having to write something the repository could have held.

Two things that generalise beyond that repo, because both are about how to choose what to
check in:

- **Replace the loop, not the landmarks.** The first attempt shipped the two most
  *visible* tools and left the rest with no home, so the next stage would rebuild them —
  the failure it claimed to fix. The tool most needed was the least conspicuous one: a
  `GO`-splitting script runner the stage used **eight times** to push a proc to DEV, run a
  migration, run its rollback, and run the migration again. Read the stage's commands for
  what it *repeated*, not for what looks like tooling.
- **A review criterion belongs in a command, not a prompt.** Three of that route's ten
  SQL review criteria — encoding, an explicit `USE`, a paired rollback — were being
  checked by each stage writing its own throwaway PowerShell. A criterion a review will
  fail you on should have an exit code. And the check has to be scoped to what the branch
  changed: 285 of 285 files carry a BOM so that check is a real invariant, but only 197 of
  285 state a database, and a check that fails on 88 files of history is one people learn
  to skip.

### Files that are local environment, not work

`domain/worktreeDiscard.ts` + `services/worktreeDiscardService.ts` + `worktree.discardPaths`
in `harness.json`. A stage's `verify` runs against the worktree, so anything permanently
dirty in it fails the check — and `Test-WorkLandedOnDev.ps1` refused to promote a task
whose work was **committed and pushed**, because the tree held nine files that were never
work: `QubeAutoApp/Web.config`, transformed to run the solution from Visual Studio against
a non-default tenant, and eight tracked files under various `bin/Debug/` that every build
rewrites with the other line ending — `Renci.SshNet.xml` reporting 46,114 changed lines
containing no change. Four worktrees were failing that way at once, on the check standing
between a route and a live publish. A gate that fails on something the operator cannot act
on is one they learn to click past, which is the failure the harness exists to prevent.

**Discarded, not ignored.** The script already has `IgnorePath` and widening it was the
obvious move; it is the wrong one, because the tree stays dirty and the next stage
inherits it, so the next check fails for the same reason. A clean tree is the actual
requirement. Ignoring also cannot be scoped — it would have to hold for every route and
every task forever, where a discard leaves a trace each time it happens.

Five rules, each load-bearing:

- **Announced in the stage report, never only in the log.** This is the one part of the
  runtime that destroys work rather than reporting on it, and `Web.config` does take real
  changes — a new `appSettings` key lands there. Announced, a wrongly removed change is a
  line someone can see and recover from the commit; silent, it is indistinguishable from
  a change never made. The same rule truncated command output follows.
- **Never an untracked file, a staged change, or a conflicted path.** Restoring a tracked
  file is a checkout from a commit; deleting an untracked one is unrecoverable, and
  untracked is where new work lives. Staging is deliberate — it is also how you *keep* a
  Web.config change past this. A conflict is a state a human is mid-way through.
- **Read from the repository root**, like rules and routes, so a branch cannot add its own
  files to the list of things deleted on its way past a gate.
- **No fallback and no default.** A project declaring nothing discards nothing, and an
  unreadable config discards nothing rather than reusing the last known list. The
  no-fallback rule rules already follow, for a stronger reason: a default here deletes
  files. Parsing likewise **rejects a malformed list outright** rather than accepting it
  in part, which is the opposite of how routes and sources parse — where this would have
  to guess, guessing wrong costs a file.
- **Stages only, before `verify`.** A hand-driven chat session must never have files
  removed from under it, which is why it is injected into `PipelineRunner` rather than
  anywhere a session could reach. A git failure is non-fatal: the discard exists to stop a
  check failing for the wrong reason, and failing the stage on its own account would trade
  one spurious failure for another.

**A dirty tree blocks two things, so the discard has two call sites.** The second is
`mergeIntoTaskCommand`, before `getLiveState`: that command answers a dirty worktree by
offering to commit or stash, which is right for work and wrong for environment — it was
offering to *commit* a Web.config pointed at another tenant's database. Both callers run
it at the same moment for the same reason, before anything reads the tree, and neither
suppresses the announcement. Note where it is **not**: `firstBlocker` still refuses a
running session and a branch mismatch before any of this, because a tree being altered
under a live agent is a different problem that a discard would make worse.

The honest fix for the build output is still to untrack it — `.gitignore` covers
`QubeAutoApp.Mapping.Services/bin/` and not `QubeAutoApp.Mapping.Data/bin/`, which is the
whole bug. This makes the routes work meanwhile.

**The declaration only ever reached the check, and was read as covering the commit**
(`domain/stagedEnvironmentPaths.ts`, 17 Aug 2026). `discard` is called from
`runVerification` — *after* the session — so by the time it looks, a commit stage has
already run its `git add` and its `git commit`. Two different failures, and only one had
a mechanism: a gate failing on a dirty `Web.config` was prevented; that same
`Web.config` reaching the branch was not prevented at all. A review caught a stage's diff
carrying it repointed at another tenant's databases through an `sa` login with the
password inline, next to the work the stage was actually asked to do. Nothing in the
runtime looked, and the reasonable conclusion from reading the config was that something
did.

Admissible in the gate on `credentialExposure`'s test, not the safety-classification one
`permissionGatePolicy` refuses: it asks nothing about whether a command is dangerous to
run, only whether it would commit a path **the project itself declared is not work** — a
fact about this harness's own configuration that no execution engine can know for it.

The rule is **incidental versus deliberate**, which is what keeps it from closing the
escape hatch. `selectDiscardable` withholds a *staged* change on purpose, so staging is
the documented way to keep a real `appSettings` edit through a discard; a blanket refusal
to commit a declared path would leave a compliant stage with no admissible form of the
call at all — unlike a leaked credential, where there is always a rewording. So
`git add -A` and `git commit -a` are refused while `git add QubeAutoApp/Web.config`
passes, in a command `SubtaskActivity.commands` records verbatim. An invisible inclusion
becomes a visible choice, auditable afterwards by the same mechanism that caught the
original failure, and a compliant stage pays one round trip.

Five rules, each load-bearing:

- **Keyed on the worktree column alone.** Nothing dirty in the tree means whatever is
  staged got there deliberately, so a later `git commit -am` is not refused on its
  account — without that the hatch works for the `add` and fails at the commit, which is
  no hatch. A path both staged *and* further modified (`MM`) is still refused: the staged
  version passed this rule and the delta on top of it did not, which is what a build
  rewriting a staged file looks like.
- **The value-taking global flags are whitelisted**, because `-C /repo` and `--no-pager`
  cannot be told apart generically — a pattern allowing an optional value after any flag
  reads `add` as `--no-pager`'s argument and matches nothing. Guessing is wrong in the
  direction of never firing, which is the failure the quoted hook command taught this
  codebase to fear.
- **The worktree read sits behind a synchronous filter.** The gate fires on *every* tool
  call and a `git status` is ~250ms, so only a command that could sweep is worth one. It
  is also what keeps `sweep` synchronous for everything else: an `await` on the common
  path defers every other decision in that sweep by a microtask, and the callers that
  drive a sweep and read the decision immediately would see nothing written. The poll
  now skips a tick while a sweep is in flight, since a read costs about as long as the
  interval.
- **A read that fails passes the call**, the direction `WorktreeDiscardService` already
  chose: refusing a stage because git was momentarily unreadable trades one spurious stop
  for another. A conflicted path is likewise left alone — a bulk `add` is how a merge is
  resolved, and a stage held mid-merge cannot proceed by any rewording.
- **The paths are named in the refusal; which of them belongs is not.** They came from the
  project's own `harness.json`, so repeating them back is not the runtime inventing
  engineering advice — the line `credentialExposure` holds. Saying which one belongs in
  the commit would be making the judgement instead of handing it over.

### One tool could open the worktree and the other could not

`MAX_WORKTREE_FOLDER_NAME` in `pathUtilities.ts`, 24 Aug 2026. A task name here is
routinely a whole sentence, and the worktree folder was `<repo>-<the whole thing
slugified>` with no cap — so seven live worktrees had roots of 97 to **173**
characters. Visual Studio then refused to load a solution with *"The imported project
file ... could not be loaded. Could not find a part of the path"*, naming a NuGet
`.targets` file that was plainly on disk.

**`LongPathsEnabled` is per process, not per machine**, and that is the whole fact.
The registry flag is honoured only for a binary whose manifest declares
`longPathAware`. Checked both:

| binary | manifest |
|---|---|
| `MSBuild.exe` (VS 18) | `longPathAware` |
| `devenv.exe` 18.9.12112.369 | **absent** |

So the same 270-character import builds under `MSBuild.exe` and is unopenable by
`devenv.exe`, with the registry set to 1 either way. The first probe here was
`MSBuild.exe` reporting `IMPORT OK`, which was a real measurement of the wrong
process and led to the wrong conclusion — the file existing and one tool reading it
says nothing about the tool the operator actually opens the solution in.

The budget is measured from the deepest path, not guessed: 170 characters of tracked
tail in that repository, so the root must be ≤ 88 to clear 259 with the separator.
A 17-character parent (`C:/Dev/worktrees/`) plus the 60-character cap is 77.

Three rules:

- **The directory is capped and the branch is not.** Refs have no length limit worth
  worrying about, and the branch name is how the work is recognised in a commit, a
  pull request and a stand-up. Capping both would pay a real cost to fix a problem
  only the filesystem has.
- **The truncated tail is replaced by a digest of the whole slug, never simply cut.**
  These names share long prefixes — two campaign tasks opening
  `include-retail-r2-dealers-in-trade-parts-rebate-campaigns-` would collide on one
  directory, and the second task would be handed the first one's worktree. Truncation
  stops at a hyphen so the name still reads as words.
- **A repository name that alone fills the cap keeps its length.** The repo name is
  the part that says which checkout this is, so the cap is overshot rather than the
  name mangled.

**Repairing an existing worktree is a move plus one field.** `git worktree move`,
then `worktreePath` — and *only* that field. The old path also appears 20 to 174
times per task inside recorded `commands`, `pathsWritten` and replies; those are the
verbatim record `claimEvidence` attributes worktrees from, and rewriting them to
tidy a path would be falsifying history. The move fails with `Permission denied`
while any process holds the root as its cwd, which for a worktree under a route
means a live `claude.exe` and its children — the holder is found by reading each
process's cwd, since only the root directory is busy and everything inside it
renames fine.

### Keeping a worktree the checkout it claims to be

Two rules in `worktreeProvisioner.ts`, both learned from a task that was dirty before
anyone touched it.

- **`copyIntoWorktree` never replaces a file already at the destination.** A fresh
  worktree contains exactly what git tracks, so a file already there is a tracked one —
  and the setting exists for the files git does *not* track. A directory entry
  (`tools/mcp/sftp/profiles`) sweeps up any tracked file inside it, and copying the main
  checkout's copy over the worktree's produced a modified file with identical content
  and different line endings, because the two checkouts had normalised differently.
- **`linkSiblings` never touches a path that is not already a link.** Links are created
  in the worktree *parent*, which is also where real repositories live, so a mistyped
  name points at a working clone; `readLink` uses `lstat`, not `stat`, because `stat`
  follows the link and makes a junction indistinguishable from a real directory. Junctions
  on Windows, which need no elevation.

The reason links are needed at all: a project referencing a sibling as
`..\..\QubeData\QubeData.csproj` resolves from a checkout beside that sibling and not
from a worktree one level deeper. A `Directory.Build.props` can probe and fix *project*
references; a `.sln` cannot, since solution files take no MSBuild properties — so the
layout the committed paths assume has to actually exist.

### Who holds which worktree

`domain/worktreeLease.ts` + `services/worktreeClaimService.ts`. Stages create worktrees
the extension never made, so nothing was cleaned up and nothing detected two tasks
overlapping on one. **Claims are detected, not requested** — the worktree list before and
after a `mayChangeBranch` stage — because the agent makes them, not the harness. The
load-bearing distinction is **created versus borrowed**: a created `promote/*` tree may be
removed, the standing `qube-publish-*` trees must not be, or the next publish has nowhere
to run. Conflicts hold the stage and are never forced. **Branches are never deleted**: a
worktree is a checkout that can be remade, a branch may hold the only copy of its commits.

**A worktree appearing during a stage says nothing about who made it**
(`domain/claimEvidence.ts`, 14 Aug 2026). Detection diffed the repository's worktree list
before and after a stage and recorded everything that appeared as the stage's doing —
which is an inference about the clock, not about the agent, over a window minutes long on
a repository one operator and several concurrent tasks all work in. The operator created
`C:/Dev/qube-live-sm` by hand for unrelated work while a promotion stage happened to be
running; it was filed as that task's, `created: true`, the class cleanup may delete. The
same window catches another task's concurrent stage and a branch switched by hand.
Attribution now needs evidence the harness already holds: a claim requires the path to
have appeared **and** one of the stage's own commands to name it — `SubtaskActivity.commands`
are recorded verbatim for exactly this kind of after-the-fact question. Three rules. The
match is on the **last path segment**, deliberately looser than comparing whole paths,
because a command spells a path however its own shell does (`C:/Dev/x`, `/c/Dev/x`,
`../x`) and a claim lost to a spelling difference is a real worktree attributed to nobody
— loose is safe only as a *conjunction* with having appeared. The commands come from the
**reply**, never re-read from the pipeline: every early exit reverts the subtask, which
discards its activity, and those are exactly the paths a promotion stage leaves by. And
the failure direction is chosen — a tree the stage really made but never named is claimed
by nobody and lists as an orphan, which is visible and reversible, where the other
failure deletes somebody's directory.

**Borrowing is a claim, and it is the one that was never recorded**
(`claimsFromSnapshots`, 14 Aug 2026). `created` versus borrowed was documented as the
distinction cleanup turns on, and only one branch of code ever wrote a claim — a path that
*appeared* — with `created: true` hardcoded. So every claim in existence said created, and
the other way a stage takes a worktree recorded nothing at all: a promotion stage checking
`promote/<ticket>-uat` out **in a standing publish tree** makes no directory appear. Its
branch therefore belonged to no task, and the tree it made it in was, for the first time,
correctly attributed and wrongly marked as this task's to delete. Detection now diffs
(path, branch) rather than path alone — a known path on a new branch is borrowed — off the
same snapshots, so it costs no extra git call. A tree ending on the branch it started on is
not a claim, or every stage would claim every worktree merely by running.

**Orphans are excluded by claimed branch as well as claimed path.** A promotion tree is
not the same directory twice: `promote/NMGB-2534-rescura-uat` was made, pushed and removed,
and matching on the path read a remade one as belonging to nobody. The branch is what the
claim is about — it is what the stage created, what carries the commits, and what survives
the checkout being tidied away. The same set filters **Create Task from Existing Branch**,
which was offering a task's own promotion branch as unadopted work.

**Claims are recorded on every exit from a subtask**, not only the one that reads the
reply. The worktrees exist the moment the session ends, whatever the reply is later
taken to mean — and a promotion stage is the likeliest of all stages to leave by
another path, since asking a question, being stopped, or having a `git push` refused is
routine for one. Recorded only on the main path, a `promote/*` tree made by a stage that
then asked something was attached to nothing: never cleaned up, and listed forever as an
orphan the harness itself had created. Conflicts are still only *held* on the main path;
elsewhere they are logged, because the stage has not passed and the next run re-snapshots.

A claim is also a *match*, in both directions. **`reconcileTasks` excludes claimed paths
from orphans** — an orphan is a worktree with no matching task, and a claim is exactly
that, so without this the harness filled its own orphan list with the trees its routes
made, which teaches a reader to ignore the list. And **removal cleans up claims before
removing the task**, using the same conservative plan as route completion: the order
matters, because `apply` re-reads the task to drop the claims it cleared, and after
`removeTask` there is no task to re-read — the claims would go and the directories stay.
What is retained is named in the confirmation dialog, since the user is agreeing to
remove worktrees they never asked for by name.

### What a stage carries forward, and what it cost

- **Handoffs** (`TaskPipeline.handoffs`) — a stage the route marks `handoff: true`
  ends its reply with a `HANDOFF:` block, which is parsed out, distilled and given
  to every later stage via `StageContext.handoffs`. A marker inside the reply, not
  a second turn: asking separately would cost a full round trip per stage to
  produce text the model already has. It is **parsed and re-emitted in priority
  order** rather than cut at the limit — a reply is written for a human, so its
  opening is restatement and the part a later stage needs is at the end, exactly
  where a blind truncation lands. A stage that writes no block has its whole reply
  carried forward as before, since the block is asked for in a prompt and can be
  ignored. The verdict line moves after the block when a stage is asked for both,
  because contradictory instructions get one of them dropped at random.
- **Discarded runs** (`TaskPipeline.discarded`, `revertToStage`'s `discard` argument) —
  what re-runs threw away. Re-opening a stage clears `reply` and `activity`, which is
  right, but **cost lives in `activity`** — so every send-back also erased the record of
  what the previous attempt cost. A task sent back six times reported the price of its
  last attempt and looked calm, which is the opposite of what running it felt like, and
  left the harness blind to the one thing it was making expensive. `pipelineUsage` now
  includes them: what a route cost is what was spent on it, not what survives on it.
  Kept per entry with the stage that was discarded and the review that caused it, for
  the same reason interventions are events — one costly stage re-run five times and a
  route that churns everywhere sum to the same money and need opposite fixes. The
  preview in the re-run command deliberately does *not* record; only the confirmed one.
- **Usage** (`SubtaskActivity.costUsd`/`tokens`, `domain/stageUsage.ts`) — cost and
  cumulative tokens are read from the session's `result` event, which never becomes
  a transcript item, so the activity watcher cannot see them. **`sessionTokensOf`
  reads the top-level `usage`; `contextTokensOf` reads `message.usage`** — the same
  four field names in different places, one a run total and one a per-turn
  snapshot. Confusing them does not fail loudly; it reports a number wrong by
  roughly the turn count. Summing across subtasks is only sound because each is a
  fresh session. Elapsed time is summed **per subtask**, never first-start to
  last-finish, because a route waits at a gate for as long as a human takes. Runs
  that reported nothing are counted and announced rather than dropped from the
  total.

**Status:** wired end to end — route picker → stages in the tree → Advance Route
drives split/run/checklist → approve gate, with outcomes for a stage that declares
`verify` coming from a process exit code rather than the agent's own account.

### What actually backs a stage

A stage without `verify` and without `planFile` is still **self-reported**:
`finishSubtask(..., "done")` records that the session ended without an error, which is a
fact about a process exiting and not about the work. That has not changed, and changing
it is not the point — most stages legitimately have no check to run.

What changed is that it is no longer *invisible*. `domain/stageEvidence.ts` derives what
backs a settled stage — `verified` > `planAccounted` > `reviewed` > `assessed` >
`selfReported` — and it is surfaced in the stage report, in the approval advice, in the
gate notification, and as a proportion across the whole route (`summariseEvidence`).

Three things make it honest rather than decorative:

- **The check that ran, not the one declared.** `TaskStage.verification`
  (`recordVerification`) holds the command and its exit code, recorded whichever way it
  went. `verify` is a declaration: a runner built without a verifier, or a stage that
  failed before its last subtask, leaves it set with nothing executed — and the report
  said "verified by" on the strength of that alone. Absence of `verification` must mean
  "no check ran", which is why the zero exit code is stored rather than implied.
- **A skipped stage is not self-reported**, it is *assessed*, and that is weaker than
  either. It made no claim; `skipReason` is where the distinction lives.
- **Silence when everything is backed.** `summariseEvidence` returns `undefined` rather
  than "0 of 4 are self-reported" — a reassurance printed on every report is read as
  decoration and then not read at all.

### Running the handoff-versus-rediscovery experiment

The question CLAUDE.md described for weeks as "measurable but not yet measured". The
numbers existed; two things did not — a way to run the *other* arm, and any durable
record of which arm a run had been.

- `domain/pipelineExperiment.ts` + `TaskPipeline.experiment` — the arm, persisted on
  the pipeline. **Not a setting**: a setting is read when a stage runs, so flipping it
  mid-route yields a run that is half of each, which is the one outcome that is neither
  arm and cannot be spotted in the numbers afterwards. The command refuses to change an
  arm on a run that has started.
- **Suppressed at delivery, not at recording.** On `no-handoffs` the stages still write
  their `HANDOFF:` blocks and the pipeline still stores them; `contextFor` simply does
  not pass them on. The arms stay comparable on what the stages did, and the run is
  still readable — an experiment that destroys its own evidence measures one number and
  answers no question about why.
- `domain/runComparison.ts` — two runs side by side. Most of the module is `warnings`,
  because the failure mode is not a wrong number but a right number about two runs that
  were not comparable: different routes, both runs on the same arm, a substituted model,
  unmeasured subtasks, a rule-added stage in only one, or one run having *proved* less
  than the other. Rendered **above** the totals: a comparison is read for its bottom
  line, so a caveat printed underneath one is a caveat nobody applied.
- **Fresh input is the number at issue** (`input + cacheCreation`), reported separately
  from cache reads. A stage that rediscovers reads files again, and that lands in fresh
  input; a single token total hides the entire effect. Interventions sit in the same
  table as cost, because a run that is cheaper and asks twice as many questions has
  moved the wrong number.

Still unmeasured until a route is actually run both ways — but that is now an
experiment rather than an anecdote.

### Config a task in flight never picked up

Two live defects found together in one state file with nine tasks in it (13 Aug 2026),
and one shared cause: **`refreshPendingStages` only touches stages that have not begun,
and a verification gate is `awaiting-approval` for its entire useful life.** So every
repair the harness had for "config changed after this task started" was unreachable for
exactly the stages that sit longest.

- `checklistScope` had been added to the project's routes months after five tasks
  started. Their gates still had none, so `scopingActive` was false and they silently ran
  the pooled behaviour scoping exists to replace — the first gate absorbing every item and
  the later ones asking for nothing.
- `checklistAudience` was added, and the tasks parked at a DEV sign-off stayed in
  **Needs you**, because the persisted stage had no audience to read.

`refreshGateDeclarations` is a second pass with its own field list and its own wider
status rule, deliberately *not* folded into `refreshPendingStages` — whose contract
("nothing that has begun is touched") is relied on elsewhere. The distinction that makes
the wider rule safe: an `intent` is an instruction **given to a run**, so a stage that ran
must keep what it ran with; a scope and an audience say which gate reads an item and whose
job it is to answer, which is a fact about what happens **next**. A *resolved* gate is
still left alone — once it has passed, who answered it is history.

**It runs on its own trigger, not in the advance path**, because the tasks that need it
are the ones nobody is advancing. At activation, and on a `.taskworkspaces/*.json` change
watched as a **file** — `onDidChangeConfiguration` fires for VS Code settings and never for
`harness.json`, so hooking it would have looked right and only ever run at activation,
which is the same class of mistake as the bug being repaired.

**Backfilling a scope can wreck a checklist, so it is withheld.** A scope is a *routing*
decision: `gateFor` sends an unscoped item to the last unresolved scoped gate. Bringing
gate scopes into line on a task whose items were written before scopes existed therefore
re-routes every one of those items at once — measured on a real task, eleven DEV sign-off
items moved onto `rc-live-verify-sm`, a **live** gate, while the DEV sign-off asked for
nothing. Gates matched config; the checklist was ruined. So scope is backfilled only when
no unchecked item lacks one — precisely the condition under which nothing can move.
`audience` is never withheld: it routes nothing. The items are deliberately **not**
auto-tagged, because a scope is the behaviour review's judgement about which environment
can answer an item, and inferring it from wording is the guess this codebase refuses
everywhere else. Re-running the review is the honest repair, and it is a human's call.

**An external gate with no items is waiting on others, not on you.** The first version of
`externalGate` keyed purely on outstanding items, which read an empty checklist as an
answered one — so a sign-off that raised nothing, or whose items route elsewhere, sat in
Needs you with nothing to read. Three outcomes, not two: something outstanding → others;
items that exist and are all **ticked** → yours, because somebody has fed back and the
approval is yours alone; nothing ever asked → others, since absence of a checklist is not
evidence that a verification happened.

### A suggestion can be linked to a task that already exists

`TaskWorkspaceService.setTaskOrigin`, and **Link to an Existing Task…** on a suggestion
row. Starting a task *from* a suggestion only serves work that has not begun, which is the
rarer case on a repository already full of it: a task adopted from a branch, or created
before a source was configured, has no `origin`, so the ticket it is plainly for goes on
being offered as work nobody has picked up — and a list that offers you what you are
already doing is one you stop reading.

Only tasks with no origin are offered, and **repointing an existing link is refused**
rather than handled silently: a task quietly moved from one ticket to another is a change
nobody could see afterwards. Unlinking is its own deliberate act, because a wrong link is
worse than none — it hides real work from the list.

The ref is shown on the task row, not only in the tooltip. It is how the task is referred
to everywhere outside the extension — a commit subject, a standup, the board — and a task
list that cannot be matched to a ticket list is two lists.

### You cannot link a task to a ticket you cannot see

The above was reachable **only from a suggestion row**, so only work the last scan returned
could be linked — and a scan lists what is *outstanding*, which is precisely the wrong set.
A task already under way is in progress or closed on the board, so the one ticket it is
plainly for is the one ticket absent from the list. Every task not started from a suggestion
was therefore unlinkable, and there was no rename command either: a task could reach
`${ticket}` with no way on earth to establish one.

It bit on a live UAT promotion. `Test-WorkPromoted.ps1 -Ticket "${ticket}"` on a task named
"Nissan GB - Data Load - Rescura" — no `origin`, no reference in the name — failed **exit 4**
while its work was committed, pushed and correct. Three separate defects, all in one failure:

- **A check that cannot be scoped is no longer run** (`pipelineRunner`, `unresolved`). It
  used to substitute nothing, run the command knowing it would fail, and log a `warn`. The
  stage still stops — a scoped check must never run unscoped — but the failure now names its
  own remedy instead of an exit code. That distinction is the whole fix: a promotion check
  reporting exit 4 *means* "this work is not on the target branch", so the harness was
  reporting the wrong fact confidently. The operator diagnosed it from the script's own
  error text. **Nothing is recorded in `TaskStage.verification`**, because a command that
  never executed certifies nothing, and `stageEvidence` reads that field to claim a stage
  was checked.
- **Set Ticket Reference…** (`setTicketReferenceCommand`) on any unlinked task row. The way
  in for every task that did not come from a suggestion, which is most of them.
- **A ref's shape belongs to the source** (`SuggestionSource.refPattern`). `TICKET_PATTERN`
  is JIRA's, hardcoded in a domain whose entire suggestion design says a `ref` is opaque and
  the extension ships no sources. It is now the fallback when nothing declares one, never
  the rule; a source keyed on numbers or GUIDs would otherwise have every real ref refused.
  An uncompilable pattern is rejected at parse time and, if one ever reaches the check,
  accepts everything — blocking work over a config error the typist cannot see from the box
  they are standing in is the worse failure.

**Verified against the source, not typed** (`domain/suggestionLookup.ts`). An unverified ref
is worse than none: it scopes the promotion check, a mistyped key matches no commits, and the
check reports that as the work not having landed — the same wrong fact, one stage later. The
lookup is a session in the same shape as a scan (same runner, same required servers, same
reply format, same parser), because a second transport to ask a smaller question would be the
runtime learning to speak JIRA. It includes the source's own `scanPrompt` for its access
knowledge and then **overrides its idea of which items count**, since the whole point is
returning a ticket that is closed or in progress.

Four rules:

- **The reply must echo the system's own spelling**, and a ref that comes back different is
  not a find. Asking for the system's spelling is what makes the comparison worth anything —
  echoing back what was asked is the cheapest possible hallucination.
- **A failed session is never "no such ticket".** An unavailable MCP server and a ref that
  does not exist produce identical silence, and conflating them tells somebody their real
  ticket is imaginary. The same distinction `SourceScanOutcome.failure` exists for.
- **Unreadable is its own outcome**, apart from `notFound`, because the remedies are
  opposites: fix the ref, versus the lookup did not work.
- **A project with no sources accepts a shape-checked ref unverified**, recorded under
  `sourceId: "manual"` and said plainly in the confirmation. Refusing would reintroduce the
  dead end one level up — a `${ticket}` route no task could ever pass — and the harness must
  never make the absence of a ticket system an unpassable gate.

### The branch chose the script that certified it

`verify` is read from the repository root, "never from a worktree — a branch must not be
able to choose the command that certifies it". That was enforced on the **string** and
defeated by the **file it names**: the command runs with the worktree as its working
directory, which is right, since a check inspects the tree it certifies — so
`tools/git/Test-WorkPromoted.ps1` resolves to the branch's copy. Declaration root-owned,
executable branch-owned.

Found as staleness, which is the benign version. A task branch cut before two fixes to a
promotion check ran the old script and failed reporting `10 of 8 commit(s)` with duplicate
SHAs, and demanded a tooling commit whose subject carries no ticket at all — every symptom
of two bugs fixed on DEV days earlier, one of them (`--no-merges` + SHA dedup) *whose own
commit message describes this exact count mismatch*. The sharp version is a branch editing
the script to `exit 0` and passing its own gate.

`${repoRoot}` is the fix: a route names its check as
`-File "${repoRoot}/tools/git/Test-WorkPromoted.ps1"` and gets the root's copy, while cwd
stays the worktree so tree checks still work. **Opt-in rather than enforced** — the harness
cannot tell a script path from any other argument without parsing shell syntax for two
shells, and rewriting a command it half-understands is worse than the hole. So the
placeholder exists, the route author uses it, and `taskRoute.ts` says why.

### Suggested work, and what a scan costs

`domain/taskSuggestion.ts` + `domain/suggestionSourceFile.ts` + `services/suggestionScanService.ts`
+ `agents/suggestionScanSessionRunner.ts`. Starting a task was the one step with no runtime
support, so the harness learned about work only when a name was typed into it.

**The abstraction is a ranked backlog, not an inbox to triage**, and that decided the
rest. An inbox needs identity, dismissal records and a content fingerprint to tell "seen"
from "changed"; none of it is needed when everything on the list has to be done eventually
and the source already holds stable names and its own lifecycle. So **hiding is a filter**
— reversible, recorded nowhere, impossible to lose a ticket through. That reasoning holds
for a ticket system and not for an inbox, which is why email is a later *source* rather
than the shape this was built around.

**Nothing in the domain knows what a source is.** A source supplies an opaque `ref` and a
`rank` from an order it declares, and a source *is* a config entry in `harness.json`
naming a scan prompt, its required MCP servers, its rank vocabulary and optionally a
model. Adding Azure DevOps or Linear is a config edit. The extension ships no sources,
exactly as it ships no review rules.

- **Identity is `sourceId` + `ref`, never content.** Proven against a live board: two
  scans of the same seven tickets returned materially different titles. A fingerprint
  would have called half of them new work every scan.
- **An unrecognised rank sorts last, never hides.** A `showFrom` naming an undeclared rank
  is rejected at parse time, because at runtime it hides nothing and a longer list than
  you asked for is indistinguishable from a busy board.
- **A scan reporting "nothing" reports nothing** (`isNothingReported`, its third caller).
- **A failed source is named on the heading**, since it yields a short list and a short
  list reads as a quiet board.

**Scanning is explicit, never on activation**, which is also what makes holding the result
in memory honest: it is exactly as old as the last time you asked, and the heading says
so.

**A scan gets its own session options, not a stage's** — no permission gate (nobody is
waiting to grant anything mid-refresh), **no protocol skill** (it emits no `VERDICT`,
`DEFERRED` or `HANDOFF`; loading it was prefix tokens teaching a protocol the scan cannot
use), and **no tools that change anything** (`SCAN_DISALLOWED_TOOLS`, via the new
`--disallowed-tools`). That last one is removal rather than refusal, the same choice
`subagentLimits` makes about the Agent tool.

**What a scan actually costs, measured three ways against a live JIRA board (13 Aug 2026):**

| run | cost | secs | turns | denials | out tok | cache new | cache read |
|---|---|---|---|---|---|---|---|
| Opus, shell-out allowed | $0.8877 | 70.1 | 8 | 3 | 3,090 | 66,019 | 298,564 |
| Opus, prompt says don't shell out | $0.4932 | 22.4 | 3 | 0 | 1,411 | 40,306 | 107,513 |
| Sonnet, tools removed | $0.3936 | 26.7 | 3 | 0 | 1,559 | 57,899 | 72,544 |

Two lessons, and the second corrects an assumption worth not repeating:

- **A denied tool is not free.** The first run wrote three `Bash` commands to parse an MCP
  result, had each refused, and spent five extra turns and $0.39 discovering the wall.
  Under the permission gate it is worse than expensive: the scan would *stop and ask* to
  approve `jq` in the middle of a read-only list refresh.
- **The model tier was the small lever, not the big one.** Opus → Sonnet saved 20%, not
  the 5× the price sheet suggests, because a scan's cost is **creating and reading a
  ~130k-token prefix**, not its 1,500 tokens of reasoning — and a different model has to
  create that prefix afresh, so `cache new` went *up*. The remaining cost is the MCP tool
  surface. Do not reach for a cheaper model expecting an order of magnitude; the lever is
  a smaller prefix or a warm cache, which means scanning once per session rather than
  repeatedly.

## Context discipline

Sessions here have historically ballooned to 500+ tool calls, dominated by `Edit`
churn and whole-file reads. Prefer targeted reads (`offset`/`limit`), fewer larger
edits, and `Explore`/subagents for broad sweeps so file dumps stay out of the main
context. Large logs or transcripts belong in a scratchpad file to be read in
slices, not pasted into the conversation.
