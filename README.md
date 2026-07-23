# Task Workspaces

A VS Code extension that manages isolated development tasks using Git worktrees
and coding agents. It acts as a lightweight orchestration layer inside VS Code:
create a task, get an isolated branch and worktree, optionally launch a coding
agent inside it, and monitor everything from one window.

The extension is **provider-neutral** — a task is an isolated workspace with an
assigned worker. Claude Code is the first worker implementation, not the product.

## Current status (MVP)

Implemented:

- Detect the active Git repository from the open workspace folder(s).
- List existing worktrees (`git worktree list --porcelain`).
- Create a task workspace: name → branch type → base branch → description, with a
  branch/path preview before creation.
- Generate git-safe branch names and worktree paths (sibling of the repo by
  default; configurable per-workspace).
- Create the branch and worktree safely (pre-flight checks; no shell strings).
- Persist task metadata in VS Code global state; reconcile against real git
  worktrees on startup and refresh.
- Sidebar tree view with status icon, branch and changed-file count.
- Open a worktree in a new VS Code window.
- Show a git diff/status summary.
- Archive a task; remove a worktree safely (guarded against uncommitted changes).
- Work with Claude in the task's worktree three ways (`taskWorkspaces.agentMode`):
  - **native** (default) — opens the worktree in a new VS Code window and
    launches the official `anthropic.claude-code` extension's own chat UI there.
    Best experience; isolated per worktree. Falls back to the built-in panel if
    the extension isn't installed.
  - **chat** — Claude runs headless (`--output-format stream-json`) as an
    invisible child process; its conversation renders in a built-in Webview panel
    in this window. Same local CLI, so auth, subscription, `.claude/*`,
    `CLAUDE.md` and permissions all still apply.
  - **terminal** — Claude runs in an integrated terminal.

Use **Open Chat** on a task at any time to (re)open its session — including after
you've closed the panel/window.

### Switching agent surface

Each task row has three start buttons — **Claude extension** (new window),
**Chat panel** (in-window), and **Terminal** — plus **Open Folder**. Launch a
task in whichever surface you want; `taskWorkspaces.agentMode` only sets which
one the create-flow's "Start Claude" uses.

### Built-in chat panel

The in-window panel renders Claude's replies as markdown (code blocks, lists,
inline code), shows tool activity as cards, and includes:

- **`/` slash-command autocomplete** — discovered from `.claude/commands`
  (project + user, namespaced as `/dir:cmd`) plus common built-ins.
- **`@` file mentions** — autocomplete over the worktree's tracked/untracked
  files (`git ls-files`).
- **Attach files** (＋) — pick files from the worktree to add to Claude's
  context (inserted as `@` references).
- **Compact** — a button (and an over-threshold banner) to compact the
  conversation via `/compact`; a header **context-size** indicator warns when it
  grows past `taskWorkspaces.compactPromptThreshold` (default 150k tokens).
- **Input history** (Up/Down), auto-growing composer, mid-turn sending, Stop.
- **Provider accent theming** — the panel is colour-coded per provider
  (Claude = clay), so multiple providers stay visually distinct. New providers
  are one entry in `agentProviderMeta.ts`.

- **Permission-mode switcher** in the header — Manual / Edit automatically /
  Plan / Auto (`default` / `acceptEdits` / `plan` / `bypassPermissions`).
  Switching restarts the session with `--resume`, so the conversation continues
  at the new mode.
- **Session history** button — lists this task's prior Claude sessions (by their
  `ai-title`) and resumes the one you pick, replaying its transcript.

Full extension parity (inline diff proposals, interactive permission prompts,
image paste) is out of scope for a webview — use **native** mode for those.

### History survives worktree removal

Claude keys history by working directory, so each worktree's conversations live
in their own bucket and are orphaned when the worktree is deleted. To prevent
loss, removing a task **archives** its transcripts into the extension's storage
first. Browse them any time via **Session History…** (view toolbar), which lists
removed tasks and opens their sessions read-only.

### Task detail view

A **Details** view is docked in the same sidebar, below the task tree. Selecting
a task updates it live with: name, description, colour-coded lifecycle phase, git
state (uncommitted changes / commits ahead of base), branch, base, worktree path,
agent, and created/updated times — plus quick-action buttons (Open Chat, Open
Folder, Show Diff, Copy Path, Archive/Restore, Remove).

### Diff viewing

**Show Git Diff** opens a read-only, syntax-highlighted diff of the task's
changes — committed changes vs the base branch, uncommitted working-tree changes,
and untracked files — served via a virtual document (no need to open the worktree
as a folder).

### Live status in the sidebar

Each task's dot reflects its derived **lifecycle phase**, colour-coded, combining
git state with agent activity:

| Phase | Colour | When |
| --- | --- | --- |
| Planning | purple (spin) | agent working, no changes yet |
| Implementing | blue (spin) | agent working, uncommitted changes present |
| Needs input | yellow | agent is waiting on you |
| Uncommitted changes | orange | at rest with a dirty working tree |
| Committed | green | clean tree, commits ahead of base |
| Ready | neutral | nothing done yet |

The description also shows changed-file or commits-ahead counts.

- **Built-in chat** sessions are tracked precisely (we own the process).
- **Native** sessions are tracked best-effort via
  `taskWorkspaces.trackNativeActivity` (default on): the extension watches each
  worktree's Claude transcript under `~/.claude/projects/<encoded-cwd>/*.jsonl`
  and infers *working* (written in the last ~10s) vs *awaiting input* (idle but
  recent). This reads an undocumented on-disk layout, so it's a hint that can lag
  or miss — disable it to track only built-in sessions.
- **Terminal** sessions are only known as running/closed.

### Built-in chat mode: permissions caveat

The headless built-in panel does not yet render interactive per-action
permission prompts, so it runs with a fixed `taskWorkspaces.permissionMode`
(default `acceptEdits`; use `plan` for read-only). Inline approve/deny (via the
stream-json control protocol) is a planned follow-up. Built-in sessions are
in-memory and end when VS Code closes. The **native** mode has none of these
limitations because it uses the official extension's full UI.

## Architecture

Three layers, wired in [`src/extension.ts`](src/extension.ts):

1. **Orchestration** (`services/`, `git/`, `persistence/`, `domain/`,
   `utilities/`) — no dependency on the `vscode` module, fully unit-testable.
2. **Agent providers** (`agents/`) — provider-neutral `AgentProvider` interface;
   `ClaudeCodeProvider` is the first implementation.
3. **Presentation** (`ui/`, `commands/`, `processes/`, `configuration/`) — the
   only layers that import `vscode`.

Git is the source of truth for worktree/branch/dirty/commit state; extension
storage owns friendly names, descriptions, agent association and lifecycle.

## Development

```bash
npm install       # install dependencies
npm run typecheck # strict TypeScript, no emit
npm test          # Vitest unit tests (no VS Code required)
npm run build     # bundle to dist/extension.js via esbuild
npm run watch     # rebuild on change
npm run package   # produce a .vsix
```

Press <kbd>F5</kbd> (Run Extension) to launch an Extension Development Host.

### Testing

- **Unit** (Vitest): pure logic — worktree parsing, branch-name and path
  generation, status parsing, reconciliation, presentation mapping, persistence.
  These files never import `vscode`.
- **Integration** (`@vscode/test-electron`): planned for a later milestone to
  cover worktree creation against a temp repo and tree rendering in the host.

## Configuration

| Setting | Description |
| --- | --- |
| `taskWorkspaces.worktreeParentDir` | Where new worktrees are created. Empty = sibling of the repository. |
| `taskWorkspaces.branchPrefixes` | Allowed branch type prefixes. |
| `taskWorkspaces.defaultBaseBranch` | Default base branch (empty = current HEAD). |
| `taskWorkspaces.claudeCommand` | Command used to launch Claude Code. |

## Deferred (not in the MVP)

Multi-agent workflow engine, Agent SDK integration, detailed agent progress,
auto-merge/PR, database/port/queue isolation, real multi-provider support,
single-window folder swapping, cloud sync.
