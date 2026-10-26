#!/bin/zsh
# Removes the login services and the menu bar app. Does not touch your repos or Claude chats.
set -u
UIDN="$(id -u)"
for L in com.flatpay.worktree-manager com.flatpay.worktree-menu com.lovemehta.worktree-manager com.lovemehta.worktree-menu; do
  launchctl bootout "gui/$UIDN/$L" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$L.plist"
done
rm -rf "$HOME/Applications/WorktreeMenu.app"
echo "Removed LaunchAgents and WorktreeMenu.app. Logs left in ~/Library/Logs/worktree-manager (delete if you like)."
