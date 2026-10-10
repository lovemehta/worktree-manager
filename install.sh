#!/bin/zsh
# Installs Worktree Manager as a login service and builds + installs the menu bar app.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
UIDN="$(id -u)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/worktree-manager"
APP="$HOME/Applications/WorktreeMenu.app"
mkdir -p "$AGENTS" "$LOGS" "$HOME/Applications"

# ---- 1. server LaunchAgent ----
SRV_LABEL=com.lovemehta.worktree-manager
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
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.err.log</string>
</dict></plist>
PLIST

# ---- 2. build menu bar app ----
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
    codesign --force --sign "WorktreeMenu Dev" --identifier com.lovemehta.worktree-menu "$APP"
  else
    codesign --force --sign - "$APP" >/dev/null 2>&1 || true
    tccutil reset Accessibility com.lovemehta.worktree-menu >/dev/null 2>&1 || true
    echo "Ad-hoc signed; run ./make-signing-cert.sh once so rebuilds keep the Accessibility permission."
  fi
else
  echo "WorktreeMenu.app up to date, not rebuilding."
fi

MENU_LABEL=com.lovemehta.worktree-menu
cat > "$AGENTS/$MENU_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$MENU_LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/WorktreeMenu</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardErrorPath</key><string>$LOGS/menu.err.log</string>
</dict></plist>
PLIST

# ---- 3. (re)load both ----
for L in $SRV_LABEL $MENU_LABEL; do
  launchctl bootout "gui/$UIDN/$L" 2>/dev/null || true
  for i in 1 2 3 4 5 6; do   # bootout is async; retry until the old instance is gone
    launchctl bootstrap "gui/$UIDN" "$AGENTS/$L.plist" 2>/dev/null && break
    sleep 1
  done
  launchctl kickstart -k "gui/$UIDN/$L"
done
sleep 1.5
if curl -sf http://127.0.0.1:7777/api/config >/dev/null; then echo "Server up: http://127.0.0.1:7777"; else echo "Server not responding; see $LOGS/server.err.log"; exit 1; fi
echo "Menu bar app installed: $APP"
echo "Both start at login. Uninstall: $DIR/uninstall.sh"
