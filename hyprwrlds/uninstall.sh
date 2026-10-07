#!/usr/bin/env bash
# Undo hyprwrlds/install.sh: the require line, ~/.config/hypr/hyprwrlds.lua, the bar plugin, and
# agf.hyprwrlds in the bar (put back as omarchy.workspaces). Backups go to ~/.local/share/hyprwrlds-backups/.
set -euo pipefail
hypr="$HOME/.config/hypr"; plugins="$HOME/.config/omarchy/plugins"; shelljson="$HOME/.config/omarchy/shell.json"
backups="$HOME/.local/share/hyprwrlds-backups/uninstall-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$backups"
if [[ -f "$hypr/hyprland.lua" ]] && grep -q '^require("hypr.hyprwrlds")' "$hypr/hyprland.lua"; then
  cp "$hypr/hyprland.lua" "$backups/hyprland.lua"
  sed -i '/^require("hypr.hyprwrlds")\s*\(--.*\)\?$/d' "$hypr/hyprland.lua"; echo "removed require(\"hypr.hyprwrlds\") from hyprland.lua"
fi
[[ -f "$hypr/hyprwrlds.lua" ]] && { cp "$hypr/hyprwrlds.lua" "$backups/"; rm "$hypr/hyprwrlds.lua"; echo "removed $hypr/hyprwrlds.lua"; }
if [[ -f $shelljson ]] && command -v jq >/dev/null && jq -e '.bar.layout.left[]? | select(.id=="agf.hyprwrlds")' "$shelljson" >/dev/null; then
  cp "$shelljson" "$backups/shell.json"
  jq '(.bar.layout.left) |= map(if .id=="agf.hyprwrlds" then {"id":"omarchy.workspaces"} else . end)' "$shelljson" >"$shelljson.tmp" && mv "$shelljson.tmp" "$shelljson"
  echo "bar: put omarchy.workspaces back in place of agf.hyprwrlds"
fi
command -v omarchy >/dev/null && omarchy plugin disable agf.hyprwrlds >/dev/null 2>&1 || true
[[ -d "$plugins/agf.hyprwrlds" ]] && { rm -rf "$plugins/agf.hyprwrlds"; echo "removed $plugins/agf.hyprwrlds"; }
hyprctl reload config-only >/dev/null 2>&1 || true
echo "done (backups: $backups)"
