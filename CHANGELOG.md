# Changelog

All notable changes to Task Workspaces are documented here.

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
