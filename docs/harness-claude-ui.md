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

Everything else stays in VS Code: stop, re-run, correct, send back, advance, and approving
a stage that owes a pull request. Each of those either discards work or needs a dialog
that the dashboard should not reimplement.

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
- What is *running* lives in the extension host's memory: `isRunning`, sessions, held tool
  calls under `globalStorageUri`, and live `ask_user` questions. The second client sees
  their effect on `state.json` (a subtask `active`) and nothing else.
- A repository with no state file has no runs to show. The server does not adopt the
  legacy Memento; that stays the extension's job.

## Running it

After `npm run build`, the server is `dist/harnessMcpServer.js`, and it ships inside the vsix.
Example entry for a host's MCP config:

```json
{
  "mcpServers": {
    "task-workspaces": {
      "command": "node",
      "args": ["<extension or checkout>/dist/harnessMcpServer.js", "--repo", "C:/Dev/qubeautoapp"]
    }
  }
}
```

`--repo` may be any path inside the repository. Diagnostics go to stderr.
