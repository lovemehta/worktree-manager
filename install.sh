#!/bin/zsh
# Installs Worktree Manager: the local server as a login service, plus the menu bar app (built from source).
# Re-run after pulling changes. Safe to run repeatedly.
#
# Optional settings (export before running, or prefix the command):
#   REPOS_DIR     folder that holds your git repos        default: ~/Documents/Repos
#   INTELLIJ_APP  IDE app name used by "Open in IntelliJ"  default: "IntelliJ IDEA"
#   PORT          local server port                        default: 7777
#   FORCE_BUILD=1 rebuild the menu bar app even if the source did not change
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
UIDN="$(id -u)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/worktree-manager"
APP="$HOME/Applications/WorktreeMenu.app"
REPOS_DIR="${REPOS_DIR:-$HOME/Documents/Repos}"
INTELLIJ_APP="${INTELLIJ_APP:-IntelliJ IDEA}"
PORT="${PORT:-7777}"
SRV_LABEL=com.flatpay.worktree-manager
MENU_LABEL=com.flatpay.worktree-menu

# ---- 0. prerequisites ----
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "node not found. Install Node.js 20 or newer (https://nodejs.org or 'brew install node') and re-run."; exit 1; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || { echo "Node.js 20 or newer required, found $("$NODE" --version)."; exit 1; }
command -v swiftc >/dev/null || { echo "swiftc not found. Install the Xcode Command Line Tools: xcode-select --install"; exit 1; }
[[ -d "$REPOS_DIR" ]] || { echo "Repos folder does not exist: $REPOS_DIR  (set REPOS_DIR=/path/to/your/repos)"; exit 1; }
[[ -d "/Applications/$INTELLIJ_APP.app" || -d "$HOME/Applications/$INTELLIJ_APP.app" ]] || echo "Warning: /Applications/$INTELLIJ_APP.app not found; 'Open in IntelliJ' will fail until INTELLIJ_APP matches your IDE (see README)."
command -v rg >/dev/null || echo "Tip: 'brew install ripgrep' makes chat search faster (optional)."
mkdir -p "$AGENTS" "$LOGS" "$HOME/Applications"

# ---- 1. remove legacy agents from older installs ----
for L in com.lovemehta.worktree-manager com.lovemehta.worktree-menu; do
  if [[ -f "$AGENTS/$L.plist" ]]; then launchctl bootout "gui/$UIDN/$L" 2>/dev/null || true; rm -f "$AGENTS/$L.plist"; echo "Removed legacy agent $L"; fi
done

# ---- 2. server LaunchAgent ----
cat > "$AGENTS/$SRV_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SRV_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>NO_OPEN</key><string>1</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
    <key>REPOS_DIR</key><string>$REPOS_DIR</string>
    <key>INTELLIJ_APP</key><string>$INTELLIJ_APP</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.err.log</string>
</dict></plist>
PLIST

# ---- 3. build menu bar app ----
# Rebuild only when the source changed: every rebuild changes the ad-hoc signature,
# which invalidates the Accessibility grant (System Settings → Privacy & Security → Accessibility).
BIN="$APP/Contents/MacOS/WorktreeMenu"
if [[ "${FORCE_BUILD:-0}" == 1 || ! -f "$BIN" || "$DIR/menubar/WorktreeMenu.swift" -nt "$BIN" || "$DIR/menubar/Info.plist" -nt "$BIN" ]]; then
  echo "Building WorktreeMenu.app…"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  cp "$DIR/menubar/Info.plist" "$APP/Contents/Info.plist"
  swiftc -O -framework AppKit -o "$BIN" "$DIR/menubar/WorktreeMenu.swift"
  if security find-identity -v -p codesigning | grep -q "WorktreeMenu Dev"; then
    # Stable identity (see make-signing-cert.sh): the Accessibility grant survives rebuilds.
    codesign --force --sign "WorktreeMenu Dev" --identifier "$MENU_LABEL" "$APP"
  else
    codesign --force --sign - "$APP" >/dev/null 2>&1 || true
    tccutil reset Accessibility "$MENU_LABEL" >/dev/null 2>&1 || true
    echo "Ad-hoc signed; run ./make-signing-cert.sh once so rebuilds keep the Accessibility permission."
  fi
else
  echo "WorktreeMenu.app up to date, not rebuilding."
fi

cat > "$AGENTS/$MENU_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$MENU_LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/WorktreeMenu</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>WM_URL</key><string>http://127.0.0.1:$PORT</string>
    <key>INTELLIJ_APP</key><string>$INTELLIJ_APP</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardErrorPath</key><string>$LOGS/menu.err.log</string>
</dict></plist>
PLIST

# ---- 4. (re)load both ----
for L in $SRV_LABEL $MENU_LABEL; do
  launchctl bootout "gui/$UIDN/$L" 2>/dev/null || true
  for i in 1 2 3 4 5 6; do   # bootout is async; retry until the old instance is gone
    launchctl bootstrap "gui/$UIDN" "$AGENTS/$L.plist" 2>/dev/null && break
    sleep 1
  done
  launchctl kickstart -k "gui/$UIDN/$L"
done
sleep 1.5
if curl -sf "http://127.0.0.1:$PORT/api/config" >/dev/null; then echo "Server up: http://127.0.0.1:$PORT  (repos: $REPOS_DIR)"; else echo "Server not responding; see $LOGS/server.err.log"; exit 1; fi
echo "Menu bar app installed: $APP  (look for the branch icon in the menu bar; ⌘⇧Space opens the switcher)"
echo "Both start at login. Uninstall: $DIR/uninstall.sh"
