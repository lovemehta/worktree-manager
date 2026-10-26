# Worktree Manager

A small local tool for people who work with many git worktrees and Claude Code.

- **Web UI** at `http://127.0.0.1:7777`: every repo and worktree in your repos folder, create and delete worktrees, open any of them in IntelliJ, and move Claude Code chats from a worktree back to the parent repo before you delete it.
- **Search across all Claude Code chats** from every repo and worktree, including worktrees you already deleted, so you can find "where did I discuss X" and resume that chat.
- **macOS menu bar switcher**: a branch icon in the menu bar listing all repos and worktrees, plus a Spotlight-style palette on ⌘⇧Space that opens the chosen folder in IntelliJ.

No dependencies beyond Node.js. The server only listens on `127.0.0.1`.

## Requirements

| What | Why | Check |
| --- | --- | --- |
| macOS 13 or newer | menu bar app, LaunchAgents | |
| Node.js 20 or newer | the server | `node --version` |
| Xcode Command Line Tools | compiles the menu bar app (`swiftc`) | `xcode-select --install` |
| IntelliJ IDEA (Ultimate or Community) | "Open in IntelliJ" | installed in `/Applications` |
| Claude Code | chats to list and search | optional, everything else works without it |
| ripgrep | faster chat search | optional, `brew install ripgrep` |

All repos must live as direct subfolders of one folder, `~/Documents/Repos` by default. Worktrees created by this tool are placed next to the repo as `<repo>-<branch>`; worktrees created elsewhere are picked up too via `git worktree list`.

## Install

```sh
git clone <this repo> ~/Documents/Repos/worktree-manager
cd ~/Documents/Repos/worktree-manager
./install.sh
```

`install.sh` checks the requirements, installs two LaunchAgents that start at login and restart on crash, builds `~/Applications/WorktreeMenu.app`, and starts both. Open `http://127.0.0.1:7777` in a browser and look for the branch icon in the menu bar.

If your repos live somewhere else, your IDE has a different name, or port 7777 is taken, pass settings on the command line. They are baked into the LaunchAgents, so you only do this once (re-run with the same values after updates):

```sh
REPOS_DIR=~/code INTELLIJ_APP="IntelliJ IDEA CE" PORT=7800 ./install.sh
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `REPOS_DIR` | `~/Documents/Repos` | folder whose subfolders are your git repos |
| `INTELLIJ_APP` | `IntelliJ IDEA` | app name as in `/Applications/<name>.app` |
| `PORT` | `7777` | server port; the menu bar app follows it |
| `CLAUDE_DIR` | `~/.claude` | where Claude Code keeps its data (only needed when running the server by hand) |

Two one-time macOS prompts to expect:

1. **Accessibility** for WorktreeMenu, under System Settings → Privacy & Security → Accessibility. With it, choosing a project that is already open in IntelliJ raises that window instead of re-opening it. Without it everything still works, with a short loading flash. Run `./make-signing-cert.sh` once before granting it: it creates a local self-signed signing identity so rebuilds of the app keep the grant. Without it every rebuild resets the permission.
2. **⌘⇧Space clash with 1Password** Quick Access. Turn that off in 1Password → Settings → General → Keyboard Shortcuts, or change the hotkey in `menubar/WorktreeMenu.swift` (`registerHotKey(keyCode: kVK_Space, modifiers: cmdKey | shiftKey)`) and re-run `./install.sh`.

IntelliJ tip: set Settings → Appearance & Behavior → System Settings → "Open project in" to **New window** so it never asks.

### Update

```sh
cd ~/Documents/Repos/worktree-manager && git pull && ./install.sh
```

The menu bar app is only rebuilt when its source changed.

### Uninstall

```sh
./uninstall.sh
```

Removes the LaunchAgents and the menu bar app. Your repos, worktrees and Claude chats are untouched.

### Run without installing

```sh
npm start        # starts the server on 7777 and opens the browser; Ctrl-C to stop
```

Same `REPOS_DIR`, `INTELLIJ_APP`, `PORT`, `CLAUDE_DIR` variables apply. `NO_OPEN=1` skips opening the browser.

## Using the web UI

Repos are listed most recently used first (by latest Claude chat), the top five shown by default with a "show more" button. Each repo card has:

- **Chats**: the Claude chats stored for the repo folder. For a worktree the same dialog lets you tick chats and **migrate** them into the parent repo.
- **Open in IntelliJ**: `open -a "<INTELLIJ_APP>.app" <path>`. Reuses the running IntelliJ; an already-open project is brought to front.
- **New worktree**: creates `<REPOS_DIR>/<repo>-<branch>` (slashes in the branch become `-`). Reuses a local branch, tracks `origin/<branch>` if it exists, otherwise creates the branch from the base ref (default `origin/HEAD`). Optionally runs `git fetch --prune` first.
- **Prune**: `git worktree prune`, which drops Git's records of worktrees whose folder was deleted by hand.

Each worktree row has **Chats**, **Open in IntelliJ** and **Delete**. Delete shows the worktree's Claude chats; ticked ones are copied into the parent repo first, then `git worktree remove` runs (optionally `--force`, optionally `git branch -D`). Unticked chats stay on disk unless "delete remaining" is ticked.

### Search all chats

The search box in the header searches every Claude Code transcript on this machine, across all repos and worktrees, including worktrees that no longer exist. It is a case-insensitive literal substring match, not a regex, so `foo(bar)` or `TRX-922` match exactly what you typed.

- By default it matches your prompts and Claude's replies. Tick **include tool output** to also match command output, file contents and tool inputs.
- Results are grouped per chat, newest first: folder, branch, chat title, hit count and up to three snippets labelled You / Claude / Tool. Chats whose folder is gone are marked "folder gone".
- **Open in IntelliJ** opens the git root of the folder the chat ran in. **Copy resume command** copies `cd <folder> && claude --resume <id>`; paste it in a terminal to continue that chat. If the folder is gone, migrate the chat to the parent repo first (Chats → Migrate), then resume it there.
- `/` focuses the box, Esc clears it, and the URL carries `?q=` so a search survives a reload.

## Menu bar app and switcher

- The branch icon lists each repo as a submenu: "Open main" plus every worktree, with a "Recent" section of the last six picks. The list refreshes when the menu opens and every 60 s.
- **⌘⇧Space** opens a palette: type to filter repos and worktrees (sorted by most recent Claude chat), ↑/↓ to move, Enter opens in IntelliJ, Esc closes. Also reachable from the menu ("Switcher") or with `pkill -USR1 -x WorktreeMenu`.
- If the server is down the menu shows "Start server" and still opens IntelliJ directly as a fallback.

## How chats are found

Claude Code stores each chat as `~/.claude/projects/<folder path with every non-alphanumeric character replaced by ->/<session-id>.jsonl`, one folder per working directory the chat was started in. This tool reads those files; it never writes to them except when you migrate a chat, which copies the file to the parent repo's folder, rewrites the path strings inside, and updates `~/.claude/history.jsonl` with a timestamped backup next to it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `install.sh` says node or swiftc not found | install Node 20+ or run `xcode-select --install`, then re-run |
| Server not responding after install | `cat ~/Library/Logs/worktree-manager/server.err.log`; typical cause is another process on the port, install with `PORT=7800 ./install.sh` |
| "Open in IntelliJ" does nothing | the app name differs; `ls /Applications | grep -i intellij` and re-run install with `INTELLIJ_APP="<that name without .app>"` |
| Switching to an open project flashes a loading frame | grant Accessibility to WorktreeMenu, see Install |
| Accessibility keeps resetting | run `./make-signing-cert.sh` once, then `FORCE_BUILD=1 ./install.sh` and grant again |
| ⌘⇧Space opens 1Password | see Install |
| Menu bar icon missing | `launchctl kickstart -k gui/$(id -u)/com.flatpay.worktree-menu`, log in `~/Library/Logs/worktree-manager/menu.err.log` |
| Restart the server by hand | `launchctl kickstart -k gui/$(id -u)/com.flatpay.worktree-manager` |

## Layout

```
server.mjs              HTTP server and all git / Claude logic (no dependencies)
index.html, app.js      web UI
menubar/                WorktreeMenu.swift and Info.plist, compiled by install.sh
install.sh              LaunchAgents + build; uninstall.sh removes them
make-signing-cert.sh    one-time local signing identity for the menu bar app
```

API, all on `127.0.0.1`: `GET /api/repos`, `GET /api/sessions?path=`, `GET /api/search?q=&tools=0|1&path=`, `GET /api/recent?n=&path=`, `GET /api/default-base?repo=`, `POST /api/worktree/{create,open,delete,prune}`, `POST /api/sessions/migrate`.
