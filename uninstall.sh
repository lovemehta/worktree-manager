#!/bin/zsh
set -u
UIDN="$(id -u)"
for L in com.lovemehta.worktree-manager com.lovemehta.worktree-menu; do
  launchctl bootout "gui/$UIDN/$L" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$L.plist"
done
rm -rf "$HOME/Applications/WorktreeMenu.app"
echo "Removed LaunchAgents and WorktreeMenu.app"
