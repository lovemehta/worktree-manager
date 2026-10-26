# Worktree Manager

Local web UI for git worktrees under `~/Documents/Repos`, with Claude Code chat migration.

## Run

```sh
cd ~/Documents/Repos/worktree-manager
npm start          # opens http://127.0.0.1:7777
```

Optional env: `REPOS_DIR`, `CLAUDE_DIR`, `INTELLIJ_APP` (default `IntelliJ IDEA`), `PORT`, `NO_OPEN=1`.

## What it does

- Lists every git repo (directory with a `.git` folder) in the repos dir and its worktrees (`git worktree list`).
- **New worktree**: creates `<repos>/<repo>-<branch>` (slashes in the branch become `-`). Reuses a local branch, tracks `origin/<branch>` if it exists, otherwise creates the branch from the base ref (default `origin/HEAD`).
- **Open in IntelliJ**: `open -a "IntelliJ IDEA.app" <path>` (reuses the running IntelliJ; an already-open project is brought to front).
- **Delete**: shows the Claude Code chats stored for that worktree path. Ticked chats are copied into the parent repo's Claude project folder (path strings inside the transcript are rewritten to the parent path, and `~/.claude/history.jsonl` is updated with a timestamped backup). Then runs `git worktree remove` (optionally `--force`, optionally `git branch -D`). Unticked chats are left in place unless "delete remaining" is ticked.
- **Chats**: view a worktree's chats and migrate selected ones without deleting the worktree.
- **Prune**: `git worktree prune` for entries whose directory is gone.
- **Search all chats**: the header search box runs a case-insensitive literal substring search (not regex) over every transcript under `~/.claude/projects`, across all repos and worktrees, including worktrees that were deleted. Results replace the repo list while the box has text (Esc clears it; `/` focuses it). Each result shows the folder, branch, chat title, hit count and up to three snippets labelled You / Claude / Tool. By default only your prompts and Claude's replies are matched; tick "include tool output" to also match command output, file contents and tool inputs. "Open in IntelliJ" opens the git root of the folder the chat ran in; "Copy resume command" copies `cd <folder> && claude --resume <id>`; if the folder is gone, migrate the chat to the parent repo first (Chats → Migrate). The URL carries `?q=` so a search survives a reload. Uses `rg` when installed, otherwise a slower Node scan. API: `GET /api/search?q=<text>&tools=0|1&path=<folder>`; `GET /api/recent?n=10&path=<folder>` lists the newest chats.

Claude Code stores chats in `~/.claude/projects/<path with every non-alphanumeric char replaced by ->/<session-id>.jsonl`.

## Always on + menu bar

```sh
./install.sh     # installs two LaunchAgents (start at login, restart on crash) and builds ~/Applications/WorktreeMenu.app
./uninstall.sh   # removes both
```

- `com.lovemehta.worktree-manager` runs `node server.mjs` on port 7777. Logs: `~/Library/Logs/worktree-manager/`.
- `com.lovemehta.worktree-menu` runs the menu bar app (branch icon). Each repo is a submenu: "Open main" plus every worktree. Clicking opens that folder in IntelliJ via `open -a "IntelliJ IDEA.app"`; if the project is already open, IntelliJ brings its window to front. A "Recent" section lists the last six picks. The list refreshes when the menu opens and every 60 s.
- If the server is down, the menu shows a "Start server" item and still opens IntelliJ directly as a fallback.
- Rebuild after editing `menubar/WorktreeMenu.swift`: run `./install.sh` again.

IntelliJ tip: set Settings → Appearance & Behavior → System Settings → "Open project in" to **New window** so it never prompts.

## Switcher (⌘⇧Space)

The menu bar app registers a global hotkey ⌘⇧Space that opens a Spotlight-style panel. Type to filter repos and worktrees (sorted by most recent Claude chat), ↑/↓ to move, Enter opens in IntelliJ, Esc closes. Also reachable from the menu bar menu ("Switcher") or with `pkill -USR1 -x WorktreeMenu`.

If 1Password's Quick Access also uses ⌘⇧Space, turn it off in 1Password → Settings → General → Keyboard Shortcuts → Show Quick Access. Change the hotkey in `menubar/WorktreeMenu.swift` (`registerHotKey(keyCode: kVK_Space, modifiers: cmdKey | shiftKey)`), then rerun `./install.sh`.

## Switching to an already-open project

When IntelliJ already has a window whose title starts with the folder name, the menu bar app raises that window via the Accessibility API instead of sending IntelliJ an open event (which flashes a loading frame). macOS asks once to allow WorktreeMenu under System Settings → Privacy & Security → Accessibility. Without that permission it falls back to the normal open. Run `./make-signing-cert.sh` once: it creates a local self-signed code-signing identity, and `install.sh` then signs the app with it so rebuilds keep the Accessibility grant. Without it the app is ad-hoc signed and every rebuild resets the grant.
