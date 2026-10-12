# Claude as a second client of the harness

The harness should not depend on the program that displays it. This is the proof: Claude
reads and acts on the same task runs as the VS Code extension. It does this through an
MCP server and an MCP App dashboard, over the **one** state file both already use. There
is no second store, no daemon and no HTTP API.

## Shape

```
VS Code extension ─┐                         ┌─ Claude (MCP host)
  tree, commands   │                         │    harness_* tools
  PipelineRunner   │                         │    ui:// dashboard (MCP App)
                   ▼                         ▼
        TaskStateStore ──── <git common dir>/task-workspaces/state.json ──── TaskStateStore
        (in the extension host)   atomic rename + state.json.lock       (dist/harnessMcpServer.js)
                   ▲                                                        │
                   └──── fs.watch on the directory ◄── written by ──────────┘
```

| Piece | Role | `vscode`? |
|---|---|---|
| `src/mcp/main.ts` | Stdio entry. Opens the store exactly as the extension does. | No |
| `src/mcp/harnessMcpServer.ts` | JSON-RPC, tool and resource registration, text for the model. | No |
| `src/mcp/harnessDashboardHtml.ts` | The `ui://task-workspaces/harness-dashboard.html` view. Self-contained, no network. | No |
| `src/services/harnessControlService.ts` | Reads snapshots and applies the three decisions through `repository.update`. | No |
| `src/domain/harnessControl.ts` | Pure guards: stale revision, stage in flight, already approved, pull request owed. | No |
| `src/domain/pipelineRevision.ts` | A hash of the pipeline, used as an optimistic-concurrency token. | No |
| `src/ui/harnessSnapshot.ts` | The view model, reusing the tree's `stagePresentation` and `stageEvidence`. | No |
| `src/persistence/stateFileWatcher.ts` | Lets VS Code notice writes from the other client. | No |

`headlessBoundary.test.ts` lists `src/mcp/main.ts` and `harnessControlService.ts` as roots,
so a `vscode` import anywhere beneath them fails a test, not the bundle.

## Tools

Read tools, offered to every host: `harness_dashboard` (opens the view), `harness_list_runs`,
`harness_get_run`, `harness_get_stage_report`.

Decision tools: `harness_approve_stage`, `harness_retry_stage`, `harness_set_checklist_item`,
plus `harness_refresh` for polling. The server registers these **only** when the host
advertises the `io.modelcontextprotocol/ui` extension, and marks them
`visibility: ["app"]`. So the model can read a run and cannot approve one. Approval is a
button a person presses, so "Claude says it looks good, so approved" has no path.

Also app-only: `harness_correct_stage`, `harness_rerun_stage`, `harness_send_back`,
`harness_answer_questions`, `harness_decide_held_call`, `harness_advance_route` and
`harness_stop_route`. Approving a
stage that owes a pull request stays in VS Code, which has the dialog for it.

Checklist items and declined work are also app-only:

- `harness_note_checklist_item` records what was seen and never ticks.
- `harness_cover_checklist_item` attaches a check the item's gate has run, or records a gap.
  It ticks the item at once if that check passed.
- `harness_retire_checklist_item` withdraws an item nothing can answer. It needs a reason
  and counts as a `retirement` intervention.
- `harness_settle_deferral` settles one declined item. It needs a sentence, and it starts
  the route when that was the last item holding it, as answering does.

## The pane opens itself

In an interactive session whose repository has `.taskworkspaces/harness.json`, the pane
opens at `session.start` without taking focus. It never opens in a `-p` run (no `surface`),
which is what every stage session is. Below 144 columns the host leaves it unplaced, and
`/harness` still opens it.

## Running a route without VS Code

`harness_advance_route` starts `dist/harnessRunner.js advance --repo <root> --task <id>`
(`src/runner/main.ts`). It always runs headless, even with VS Code open, so the pane
never depends on a window.

- **Same runner as the extension.** Both build it with `services/stageRuntime.ts` and
  drive it with `services/routeDriver.ts`. That covers the pre-advance sync
  (`domain/advancePreparation.ts`) and the run lease.
- **Settings come from VS Code's own files**: the user `settings.json`, then the
  repository's `.vscode/settings.json` (`configuration/vscodeSettingsFiles.ts`). The log
  names the files it read. Profiles, `.code-workspace` files and language-scoped settings
  are not read.
- **Started in two steps.** `--detach` re-launches itself detached and exits at once. On
  Windows a host that tree-kills a timed-out tool call reaches a detached child while its
  parent is alive, but not once the parent has gone. Probed both ways.
- **A run lease** (`TaskPipeline.runLease`, `domain/runLease.ts`) stops two processes
  advancing one task. It is taken inside `repository.update`. A holder the OS says is
  dead is taken over, checked by pid *and* process start time. A probe that fails, or a
  holder on another host, counts as alive. VS Code's stale-subtask sweep skips a task
  another live process holds.
- **Stop is a request in the state file** (`stopRequestedAt`). Whoever holds the lease
  watches the state directory and cancels its own run, then clears the request when it
  releases the lease. A request older than the lease is ignored.
- **The launcher waits for the lease** (`mcp/runLauncher.ts`), not just the spawn. A
  runner that refuses, such as VS Code holding the task, has its reason read from the log
  and shown.
- **Logs** go to `<VS Code globalStorage>/task-workspaces.task-workspaces/runner-logs/<task>.log`.
  The storage folder is shared with the extension, so its activation sweep reaps sessions
  a crashed runner left behind.

**Questions and held tool calls work headlessly** (`services/liveRequestBridge.ts`).
`interactiveQuestions` and `interactivePermissions` apply as they do in VS Code. Only the
process running a stage can release a blocked `ask_user` call or gate hook, so that
process mirrors what it is waiting on into the state file: the question as
`pendingQuestion` with a `liveCallId`, held calls as `heldCalls`. A client records the
answer or decision there, and the owner, watching the state directory, applies it and the
stage carries on mid-turn. VS Code builds the same bridge, so its own questions and holds
can be answered from the pane too. VS Code's answer panel hands a question owned by a
headless run to that run rather than putting it in the brief.

A held call offers **Allow**, **Allow for run** and **Deny** outside VS Code. Adding a
permission rule stays in VS Code, because it writes the project's settings. A process that
dies mid-hold leaves its `heldCalls` behind; clients show them only while a session is
running, and the next hold on that task rewrites the list.

## Background repairs without VS Code

Four jobs used to run only on VS Code's timers: reclaiming subtasks a dead host left
`active`, polling tickets for replies (`feedbackPollMinutes`), applying `harness.json`
edits to gates already waiting, and reaping agent processes an unclean shutdown left
running. They are now `services/housekeeping.ts`, and two hosts call it:

- **VS Code**, on the timers it always had, adding the notifications.
- **`harnessRunner tick --repo <root>`**, which runs all four once and prints a JSON
  line. The pane's `--watch` process starts it detached on open and every 10 minutes
  (`mcp/housekeepingTicker.ts`), so it runs while either client is open. It logs to
  `runner-logs/housekeeping.log`.

Both at once is safe. Every job is idempotent, and a task another live process holds the
run lease on is left to that process. That includes the process sweep, which keeps a
leased task's records even if its own snapshot predates the subtask.

## Concurrency

- **`TaskRepository.update(id, change)`** is a read-modify-write inside the per-instance
  queue and the cross-process lock. `change` sees the task as it is on disk *now*.
  Returning `undefined` writes nothing.
- **Revision check.** Every decision carries the `pipelineRevision` of the copy the person
  was looking at. If the pipeline moved since then, the decision is refused as stale and
  nothing is written. The view keeps the person's note and asks them to look again. A
  stale decision is never applied over the change.
- **In flight.** A decision is refused while any subtask is `active`. The runner saves the
  whole pipeline when the subtask settles, so a decision applied during that window would
  be overwritten.
- **Idempotent.** Approving a stage that is already `passed` reports `changed: false`. It
  does not record a second approval or a second intervention.
- **The VS Code side** now uses the same rules. Approve and retry save only if the
  pipeline is unchanged since the dialog opened, and say so when it is not ("approved
  elsewhere … nothing was approved twice"). A checklist tick is re-applied inside
  `update` against the current task.

**Refresh.** VS Code watches the state directory, not the file, because each atomic rename
replaces the file. A change is debounced 250 ms, then refreshes the tree, which the detail
view and reports already follow. The dashboard polls `harness_refresh` every 3 s while
visible. On a 16.3 MB real state file a refresh measured about 95 ms.

## What was measured

Cross-client demo, run against two real server processes plus an in-process store and
watcher: 15 of 15 checks passed.

- read + read
- Claude write → VS Code sees it
- VS Code write → Claude sees it
- double press
- two simultaneous approvals: exactly one
- stale refusal
- seven concurrent checklist ticks from three writers: no losses
- nothing written to stdout except JSON-RPC

The demo also confirmed that a plain `save()` from a stale copy is still last-writer-wins.
That is why the in-flight guard exists, and why the runner no longer uses one (below).

**The runner merges rather than overwrites** (`domain/pipelineMerge.ts`). An advance holds
its pipeline for the whole of a session and used to write it back over whatever had landed
meanwhile: a tick, a guidance note, a gate the config refresh had updated. Its `save` now
runs inside `update` and does a three-way merge against the disk copy. Values only one side
changed come from that side. Arrays of records are matched by `id`, and append-only
ledgers keep both sides' entries. Where both sides changed the same value, the runner's
value is kept and the path is logged as a warning. The merge is skipped when the disk
still holds what this runner last wrote, so a route with nobody else writing behaves
exactly as before.

**Lock defects this work exposed.** All were pre-existing, and the stress tests used four
processes incrementing one counter 200 times:

| Defect | Loss |
|---|---|
| A live holder's lock is empty between the `wx` create and the record write, and contenders broke it as a crashed holder's | 2–4 of 200 per run |
| A lock stamped a few ms in the future (V8 clock skew between processes on Windows) was treated as a different machine and broken | 43 of 200 in one run |
| No state directory yet, so `ENOENT` on create, then every first write waited 2 s and wrote unlocked | every first write |

After the fixes, losses were zero with give-up disabled. Under the default policy a write
is lost only when a writer gives up after 2 s and writes unlocked. That is the designed
fail-open, and it is announced.

## Known limits

- A clash with the runner keeps the runner's value and is announced only in the log. The
  in-flight guard still refuses decisions while a subtask runs. Ticks on a different stage
  would now survive a session, so that guard could be narrowed later.
- Other VS Code commands still `save` a task they read before a dialog. Approve, retry and
  tick are the ones moved onto `update`.
- What is *running* lives in the owning process's memory: `isRunning` and the sessions.
  Live questions and held calls are mirrored into `state.json`; nothing else is.
- VS Code's tree counts a headless run's held calls when grouping, but decides only its
  own. Decide a headless run's held calls from the pane.
- A repository with no state file has no runs to show. The server does not adopt the
  legacy Memento; that stays the extension's job.

## Running it

After `npm run build`, the server is `dist/harnessMcpServer.js`, and it ships inside the vsix.
On activation the extension also copies it, with the runner it starts, to a path that does
not change between releases (`services/serverBundleInstaller.ts`):
`%APPDATA%/Code/User/globalStorage/task-workspaces.task-workspaces/mcp-server/harnessMcpServer.js`.
**Without VS Code**, each GitHub release carries `harnessMcpServer.js` and
`harnessRunner.js` beside the vsix, and the runner installs the latest one into the same
folder:

```bash
node "$APPDATA/Code/User/globalStorage/task-workspaces.task-workspaces/mcp-server/harnessRunner.js" update
```

The folder records the release it holds in `bundle.json`. Neither VS Code's activation copy
nor `update` writes over a newer release, so an editor on last week's extension cannot put
its server back. `update --force` installs the latest even when it is older.

The folder is kept rather than moved to one the harness owns, so a host's config never
changes, and the runner's logs and gate files already live beside it.

Point a host there rather than into `~/.vscode/extensions/task-workspaces.task-workspaces-<version>`,
which names one release and goes on running it after an upgrade. The extension's output
channel logs the path at startup. Example entry for a host's MCP config:

```json
{
  "mcpServers": {
    "task-workspaces": {
      "command": "node",
      "args": ["<global storage>/mcp-server/harnessMcpServer.js", "--repo", "C:/Dev/qubeautoapp"]
    }
  }
}
```

`--repo` may be any path inside the repository. Diagnostics go to stderr.
