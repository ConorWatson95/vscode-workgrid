# Changelog

All notable changes to Task Workspaces are documented here.

## 0.16.3

- **Creating and removing a task now report progress in the status bar.** Removal
  had no indication at all while it archived transcripts, stopped the agent and
  shelled out to `git worktree remove`, so a slow removal was indistinguishable
  from a click that had not registered. Creation only covered the git call —
  copying local config into the worktree and attaching the route happened after
  the progress had closed. Each step now names itself.
- **Fixed: removing a task did not stop its route.** Only the session was
  stopped, which the driver reads as a finished turn and answers by starting the
  next subtask — against a worktree about to be deleted.
- Confirmation prompts now sit between progress items rather than underneath
  one, so the unmerged-branch warning is not shown behind a spinner.

## 0.16.2

- **Fixed: MCP servers were silently missing in every task worktree.** A worktree
  is a directory the CLI has never seen, so a project-scoped `.mcp.json` in it is
  unapproved — `enabledMcpjsonServers` stays empty and none of its servers start.
  Non-interactive sessions skip the trust *dialog*, which is not the same as
  granting trust, and a route's headless sessions have nobody to answer a prompt.
  Sessions now pass the config explicitly via `--mcp-config`, so a planning stage
  can reach the ticket tracker and database servers its prompts assume. New
  `taskWorkspaces.mcpConfigPath` (default `.mcp.json`), resolved from the
  **repository root** — MCP servers grant tool access, so a branch must not be
  able to hand itself new capabilities. `--strict-mcp-config` is deliberately not
  used, so user-scope servers are unaffected.
- **Fixed: path arguments were unquoted when the CLI is spawned through a shell.**
  `--add-dir` has always been passed a real path, and on Windows the process is
  spawned with `shell: true`, so a repository under a path containing a space was
  silently truncated at the space. Argument building moved to a pure, tested
  module (`claudeCliArgs.ts`) rather than being inferred from a running process.

## 0.16.1

- **Fixed: "Stop Agent" now stops the route, not just the session.** Killing the
  session ended the current subtask, which the driver read as "that turn
  finished" and answered by starting the next one — so the agent stopped and the
  route carried on, and a second Advance Route could end up driving the same task
  alongside the first. Stop Agent now cancels the route first, discards the
  interrupted reply, and reverts that subtask to pending, so Advance Route
  resumes from where it stopped instead of skipping past it.
- **Fixed: a task left mid-subtask by a closed window is no longer stuck.**
  `startSubtask` persists "running" before the session starts, but sessions die
  with the extension host, so the flag outlived the work and every later Advance
  Route answered "a subtask is already in flight" — permanently, with no way
  back. A running subtask the current runner never started is now reclaimed. A
  genuinely concurrent advance is still refused.
- **The per-subtask timeout is configurable and no longer destroys the work.** It
  was a hard-coded 15 minutes, and a stage that hit it was recorded as failed
  with its reply discarded — so a planning stage that had spent 15 minutes
  investigating left nothing behind, not even a diagnosis. New
  `taskWorkspaces.stageTimeoutMinutes` (default 45), and whatever the stage
  produced before the cap is kept.
- **Route progress moved to the status bar.** A route runs for many minutes and
  several tasks can run at once, so one dismissable toast per task buried the
  notifications that actually needed an answer. The sidebar already shows the
  stage and subtask; only outcomes needing a human now raise a notification.
- **Fixed: the context size was read from the wrong place, so every turn
  compacted.** A `result` event's `usage` is cumulative over the whole run, like
  `total_cost_usd` — not the size of the current context. Reading it reported
  3.8M tokens for a session whose real peak was 133k, so the auto-compaction
  threshold tripped at the end of every turn. Context is now taken only from a
  message's own usage.
- **Fixed: stage sessions no longer auto-compact.** Compaction is applied when a
  turn settles, and a subtask is a single turn, so the only compaction it could
  ever run is one on a session the runner has already finished with. Every
  subtask was paying for a summary of a context nobody would read again.
- `ClaudeStageSessionRunner` now depends on a narrow `StageSessions` interface
  and is covered by tests, including the timeout and post-settle paths.

## 0.16.0

- **Engineering harness.** A task can now be given a **route** — a declared
  sequence of stages the work must travel through — chosen when the task is
  created. "Advance Route" drives it: a planning agent splits splittable stages
  into subtasks, each subtask runs in its own fresh Claude session, and the run
  stops at the first human gate or failure. Stages and their verification items
  appear nested under the task in the sidebar.
- **Per-project routes.** Routes live in the same config as rules, so the stages a
  kind of work travels through are the project's decision — a .NET line-of-business
  app and a TypeScript library do not share a workflow. A project's routes replace
  the built-ins entirely; define none and the three built-ins are offered so the
  picker works on day one. Every route must contain a stage with
  `"gate": "approval"`, or it is rejected — a route that could pass itself would
  defeat the harness.
- **Per-project review rules.** `.taskworkspaces/harness.json` in the
  repository root holds `{ routes, rules }`; `rules` map changed file paths to the reviews they oblige — SQL review,
  behaviour review, compatibility review. Rules are re-evaluated as the diff grows
  and matched reviews are inserted before the human gate. The extension ships
  **no** rules of its own: a project with no rules file requires none. Starter
  sets are copied in by "Create Review Rules File". Rules are read from the
  repository root, never a task worktree, so a branch cannot relax the reviews it
  is subject to.
- **Behaviour review with a human checklist.** Behaviour-review stages ask the
  agent to act as a QA planner rather than a judge: its output is a checklist of
  things a person must exercise, and the terminal human-verification gate refuses
  to pass while any item is unchecked. "Show Required Reviews" reports what a
  task's real diff obliges, and works on unharnessed tasks as advice.
- **Checkpoint instead of compact.** New `taskWorkspaces.contextStrategy`. Set it
  to `checkpoint` and a session crossing the auto-compact threshold writes a
  size-capped handoff, then continues in a fresh session briefed from it, instead
  of summarising in place. The handoff and the brief sent are both logged.
- **Copy local config into new worktrees.** New
  `taskWorkspaces.copyIntoWorktree`, for untracked files a fresh worktree lacks —
  `.claude/settings.local.json` being the obvious one. Destinations that escape
  the worktree are refused; a missing source is skipped, not fatal.
- **Fixed: a schema mismatch used to discard every stored task.** The task
  repository returned an empty list on any `schemaVersion` it did not recognise,
  including one written by a *newer* build. Because worktrees with no matching
  task are reported as orphans, that turned a populated task list into a list of
  unadopted strangers, losing every task's name, description and base branch.
  Stored state is now migrated, unreadable entries are quarantined rather than
  dropped, and unknown fields are preserved.

## 0.15.0

- **Fixed the conversation replaying its opening messages partway through.**
  Resuming a session re-appends its earlier entries to the same transcript —
  verbatim, keeping their original `uuid` and timestamp — so replaying the file
  as written showed the first message and the replies after it a second time. One
  real 555-entry transcript contained 196 such repeats; across the transcripts on
  this machine it was roughly doubling the replayed conversation. Entries are now
  de-duplicated by `uuid`, keeping the first occurrence.
- Messages that genuinely repeat still show twice: identical text is not treated
  as a repeat, only an identical entry id.

## 0.14.1

- Log what a replay recovered from disk (item count, and the last item) when a
  chat resumes. Missing history is otherwise unattributable: because the CLI
  writes a reply only once the turn completes, "it was on screen and vanished on
  reload" and "it never reached the transcript" look identical from the UI.
  Check the Task Workspaces output channel next time it happens.

## 0.14.0

- **Untracked worktrees can now be removed without adopting them first.**
  Orphan rows previously offered only "Adopt", so deleting one meant creating a
  task purely in order to destroy it. There is now a trash button on the row and
  a "Remove Untracked Worktree" context-menu entry, with the same confirmations
  as the tracked Remove: it warns about uncommitted changes, offers to delete the
  branch too, and offers a forced delete if that branch has unmerged commits.

## 0.13.0

- **Fixed chat history going missing after a window reload.** Replayed
  conversations were capped at the most recent 300 items — a real 3,600-entry
  session produces 2,040, so roughly 85% of it silently vanished, including most
  user turns. Longer sessions lost more, which is why it looked intermittent. The
  cap is now 4,000 items and the transcript read allows 24 MB rather than 2 MB.
- **Truncation is no longer silent.** If either cap does bite, the replay starts
  with a note saying how many earlier messages are not shown, instead of leaving
  a gap that looks like data loss.
- The read is asynchronous now, so raising the caps doesn't reintroduce the
  freeze fixed in 0.10.1 — a multi-MB transcript no longer blocks the extension
  host while it loads.

## 0.12.1

- **Plan usage now actually refreshes on its own.** It only re-probed when the
  view became visible or when you clicked `refresh`, so leaving the sidebar open
  left it frozen — including the relative reset labels, which are rendered
  server-side and so stayed on whatever they said when the view was built. The
  visible view now ticks every minute, and the snapshot is treated as stale
  after 2 minutes rather than 5.
- The tick only runs while the view is visible, and re-renders only when the
  content actually changed — writing the webview HTML reloads it, which would
  otherwise collapse any Drivers window you had expanded and flicker once a
  minute.

## 0.12.0

- **Added a "Drivers" section beneath plan usage**, showing what the CLI
  attributes your usage to — per window (Last 24h, Last 7d) with its request and
  session counts, the behaviours it flags (`53% >150k context`,
  `51% sessions active for 8+ hours`), and the ranked Top skills / subagents /
  plugins / MCP servers. The most recent window is expanded; older ones collapse.
- Named "Drivers" rather than "Split" or "Breakdown" on purpose. The CLI states
  these are *"independent characteristics, not a breakdown"*, and they routinely
  total over 100% — one request can be long-context *and* subagent-heavy *and*
  running in parallel. They are shown as plain percentages, not bars, for the
  same reason, with a note saying so.
- Parsing skips anything it can't read rather than guessing, so a wording change
  upstream shows less instead of showing something wrong.

## 0.11.0

- **Added an "Open in Visual Studio" button**, shown in the details view only
  when the worktree actually contains a solution or project — it stays out of
  the way on a Node or Python task. The solution it will open is named beneath
  the buttons, annotated `.NET Framework` or `.NET`.
- Detection reads the file listing git already provides, then classifies the
  target framework from the project files: old-style
  `<TargetFrameworkVersion>v4.x</TargetFrameworkVersion>` and SDK-style
  `<TargetFramework>net48</TargetFramework>` are both .NET Framework, `net8.0`
  and `netcoreapp*` are modern, and multi-targeting counts as Framework if any
  target is. Results are cached per worktree.
- Visual Studio is located with `vswhere`, requiring `devenv.exe` specifically.
  `vswhere -latest -products *` is not trustworthy: other products build on the
  Visual Studio shell and are listed alongside it — on this machine SQL Server
  Management Studio 22 was returned as "latest", ahead of Visual Studio, so a
  solution would have opened in SSMS. If no install is found you're offered the
  shell's default association instead.
- **Added a "File Explorer" button** to every task, which reveals the worktree
  in the OS file manager. Also available from the task's context menu, along
  with Open in Visual Studio.

## 0.10.1

- **Fixed the chat panel hanging on open.** Replaying a prior conversation read
  the entire transcript synchronously — and transcripts reach tens of MB (9.3 MB
  locally), so the whole window froze while it parsed. Only the last 300 entries
  are ever shown, so it now reads just the tail (capped at 2 MB), discarding the
  leading partial line.
- **Opening now reports what it is doing** in the status bar — *checking for a
  running session…*, *loading conversation history…* — instead of looking
  ignored until the panel appears.
- The session scan and the file/slash-command scan now run concurrently rather
  than one after the other, and the `claude agents --json` timeout is 5s rather
  than 10s: it is advisory, so failing fast and starting beats a long stall.

## 0.10.0

- **Plan usage is now its own sidebar view**, alongside Task Workspaces and
  Details, rather than a section inside Details. Usage is account-wide, so it
  shouldn't appear and disappear with the tree selection. It re-probes whenever
  the view becomes visible.
- **Removed the session cost chip** from the chat header. On a subscription the
  dollar figure is notional — you aren't billed per token — so it sat next to
  the real limits implying a cost that isn't charged.
- **The `/compact` summary no longer replays as a giant user message.** Compact
  injects its summary as an ordinary `user` transcript entry flagged
  `isCompactSummary` but *not* `isMeta`, so reopening a compacted session
  rendered the whole summary as something you had typed. It is suppressed, and
  the compaction boundary now shows as a divider instead — `Context compacted —
  474k → 15k tokens`.
- **Typing `/compact` now behaves like the Compact button.** Only the button set
  the internal flag, so a typed `/compact` produced no marker and left the
  context chip on its stale pre-compact number.

## 0.9.1

- **Fixed usage bars always rendering full.** The fill width was set via a
  `style="width:N%"` attribute, but the view's CSP specifies `style-src` without
  `'unsafe-inline'`, so inline style attributes were dropped entirely — an unset
  width falls back to `auto`, i.e. a full bar, so every window looked maxed out.
  Dynamic widths now come from a nonce'd `<style>` block, and `.usage-fill`
  defaults to zero width so a missing rule can never read as 100% again. The
  same bug silently discarded the phase colour on `<body>`; that is fixed too.
- **Reset times are now relative**, matching the Claude extension's style —
  `resets in 2 days`, `in 7 hrs`, `in 45 mins` — instead of an absolute
  `Jul 30, 2pm (Europe/London)`. The original text is kept as the tooltip. If a
  reset clause can't be parsed it is shown verbatim rather than guessed at.

## 0.9.0

- **Plan usage percentages now show in the Details view**, below the task
  details, with a progress bar per limit window (session, weekly, per-model),
  its reset time, and a manual `refresh`. Bars turn amber past 75% and red past
  90%. Also shown when no task is selected, since usage is account-wide.
- Figures come from the CLI's `/usage`, run in a **throwaway session** so it
  never appears in your chat transcript. `/usage` is answered locally — the
  reply is a `<synthetic>` model with zero input and output tokens — so this
  costs no tokens, only a process spawn. Results are cached for 5 minutes and
  re-probed when the view is shown.
- The output is human-readable text with no machine-readable equivalent, so
  parsing is deliberately tolerant: if the format changes, the section reports
  "Usage unavailable" rather than showing something wrong, and the live chips
  added in 0.8.0 keep working.

## 0.8.0

- **Plan usage is now always visible in the chat panel and updates live.** The
  CLI pushes a `rate_limit_event` unprompted on the normal stream, so the header
  shows the current window (e.g. `5h`), a `resets in 2h 15m` countdown that
  ticks on its own, and an overage flag — with no polling, no extra turns and no
  cost. Anything other than `allowed`, or an active overage, is highlighted.
- **Session cost is shown** alongside it, read from `total_cost_usd` on the
  turn's result event.
- **Reordered the task buttons** so Chat comes before the Claude-extension
  button.
- **Removed the duplicate "Open Workspace" button** from the task row and
  context menu — the Claude-extension button already opens the worktree in a new
  window. The command itself is retained (the create flow and the details view
  still call it) and remains available from the Command Palette.

## 0.7.0

- **Sessions are now discovered from `claude agents --json` (query → reuse →
  create).** Opening a chat first asks the CLI what is actually live. If this
  window already owns a session for the task it is reused as before; if a
  session we don't own is running in that worktree — left over from a previous
  window, a terminal-mode session, or one you started yourself — you are offered
  the choice to continue it or start a separate one, instead of silently running
  two agents in the same directory.
- **Discovered sessions are never terminated automatically.** Your own
  interactive Claude sessions legitimately run in these directories, so the
  extension only ever offers to adopt or to start alongside.
- Worktree matching is exact and done client-side rather than via the CLI's
  `--cwd` flag, which matches descendants recursively; a repo-root query would
  otherwise sweep in sessions from every worktree nested beneath it. Matching is
  case-insensitive and separator-agnostic because the CLI reports drive letters
  inconsistently (`c:\` and `C:\` both appear in a single listing).

## 0.6.0

- **Added a "New" button to the chat panel — start a fresh session.** Every
  existing path resumed the same Claude session id, so a wedged session was
  sticky and deleting the worktree was the only escape. "New" abandons the
  conversation and starts a session with an empty transcript (no `--resume`, no
  carried-over messages). Confirms first; the old session stays open-able under
  History.

## 0.5.2

- **Show the model a session is actually running on.** The panel header now
  displays the model reported by the CLI's `system`/`init` event (e.g.
  `opus-5[1m]`), so the running model is visible rather than inferred from the
  dropdown. See *Known issues* below for why this matters.

## 0.5.1

- Style the model dropdown to match the permission-mode dropdown — it was
  rendering as an unstyled browser default. Added hover and focus states, and
  both dropdowns are now disabled in read-only history view.

## 0.5.0

- **Model switcher labels no longer hardcode versions.** 0.4.9 labelled the
  options with version numbers and asserted Opus topped out at 4.8 — wrong, and
  stale as soon as Opus 5 shipped. The values were always family *aliases* that
  resolve to the latest model in each family, so the labels are version-agnostic
  again.
- The `taskWorkspaces.model` setting now accepts an explicit model id (e.g.
  `claude-opus-5`) instead of being restricted to a fixed list.

## 0.4.8

- **Added a model switcher to the chat panel.** A Model dropdown
  (Default / Fable / Opus / Sonnet / Haiku) maps to the CLI's `--model`.
  Switching restarts the session on the chosen model via the existing resume
  path and persists the choice via the new `taskWorkspaces.model` setting.

## 0.4.7

- **Added `taskWorkspaces.autoCompactThreshold`.** When a session's context
  exceeds this many tokens, `/compact` is issued automatically at the end of the
  current turn. Defaults to `0` (off). Recommended to set it above
  `compactPromptThreshold` so you are warned first — e.g. `160000`.
- **Fixed the context chip after `/compact`.** It kept showing the stale
  pre-compact number until the next turn, so compaction looked like it had not
  happened. The chip now shows a "compacted" placeholder immediately and the
  next turn's usage repopulates the real size.

## 0.4.6

- **Made the large-context warning harder to miss.** The compact prompt was a
  faint 14% tint; it is now a warning-coloured bar with an icon, accent border
  and a prominent Compact button, plus a brief pulse when it appears. The
  context chip also pulses once over threshold.

## 0.4.5

- **Fixed the permanent "Session ended with an error" loop.** Recovery passed a
  session id whose transcript had never been written (the first turn errored
  before any save), so every `--resume` failed with *No conversation found* and
  the chat could never recover. Both resume paths now check the transcript
  exists and otherwise start a fresh session, carrying the in-memory transcript
  forward.

## 0.4.4

- **Surface the real cause of an errored turn.** Error results often arrive with
  empty result text, so the panel only showed a generic message. It now falls
  back to the result subtype and captures a tail of the CLI's stderr, rendered
  as a collapsible detail.

## 0.4.3

- **Resume after an errored turn, not just a dead process.** An error `result`
  marks the turn complete, so the session sat in `waiting` with the CLI alive
  but unresponsive; the next message was written into the stuck process and
  silently ignored.

## 0.4.2

- **Resume ended chat sessions on send instead of dropping the message.** A
  failed or stopped session left its child process dead, so `send()` silently
  no-opped and the composer looked broken. Sending now transparently resumes.

---

## Known issues

- **"Default" model selection is non-deterministic on resumed sessions.** With
  Default selected no `--model` is passed, and resuming without one does not
  reliably inherit the current default: a resumed session reported plain
  `claude-opus-5` where a fresh one got `claude-opus-5[1m]`, and a resumed
  `haiku` session came back as `claude-sonnet-5`. **Choose an explicit family
  (e.g. Opus) if you need a predictable model.** The header chip added in 0.5.2
  shows which model a session is actually on.
- **Auto-compact has not been exercised in a live session.** The setting
  defaults to `0` (off). Treat it as untested when enabling it.
- **The underlying cause of `error_during_execution` on a first turn is not
  diagnosed.** 0.4.2–0.4.5 fix the *recovery* from it (you can always continue
  the chat), not the trigger. If you hit it, the stderr detail added in 0.4.4
  should show the cause — please share it.
