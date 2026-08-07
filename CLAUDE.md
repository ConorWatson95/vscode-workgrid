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
- **Approval notes** (`TaskPipeline.guidance`) — approving asks for an optional
  note. It is cumulative, handed to every later stage via `StageContext.guidance`,
  and the prompt says it outranks the brief. The gate is the one moment a human has
  just read what a stage produced and knows something the route does not; without
  somewhere to put it, acting on it meant editing the brief or re-running a stage.
- **`agents/stageActivity.ts` + `ui/stageReport.ts`** — a stage session's reply used
  to be parsed for a marker and discarded, so a deployment preview that printed
  pages of output left nothing behind. `StageActivityWatcher` (fed from the same
  subscription as `DenialWatcher`) records tool counts, commands **verbatim**, files
  written/read and command output; `formatStageReport` renders it as markdown.
  Output is capped (`MAX_OUTPUT_CHARS`) because it lands in the state file, which is
  read and rewritten whole — and truncation is announced, since output that just
  stops reads as the command having stopped.

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
- Settling one **requires a sentence**, not a tick. What was missing when every
  stage declined the work was the knowledge of who owns it, so silence would
  reproduce the gap. Items raised by a re-opened stage are ignored, exactly as
  that stage's checklist items are discarded.

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

## Context discipline

Sessions here have historically ballooned to 500+ tool calls, dominated by `Edit`
churn and whole-file reads. Prefer targeted reads (`offset`/`limit`), fewer larger
edits, and `Explore`/subagents for broad sweeps so file dumps stay out of the main
context. Large logs or transcripts belong in a scratchpad file to be read in
slices, not pasted into the conversation.
