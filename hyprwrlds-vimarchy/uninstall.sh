#!/usr/bin/env bash
# Undo hyprwrlds-vimarchy/install.sh: the require line, ~/.config/hypr/hyprwrlds-vimarchy.lua and the
# overlay plugin. Backups go to ~/.local/share/hyprwrlds-backups/.
set -euo pipefail
hypr="$HOME/.config/hypr"; dest="$HOME/.config/omarchy/plugins/agf.hyprwrlds-vimarchy"
backups="$HOME/.local/share/hyprwrlds-backups/uninstall-vimarchy-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$backups"
if [[ -f "$hypr/hyprland.lua" ]] && grep -q '^require("hypr.hyprwrlds-vimarchy")' "$hypr/hyprland.lua"; then
  cp "$hypr/hyprland.lua" "$backups/hyprland.lua"
  sed -i '/^require("hypr.hyprwrlds-vimarchy")\s*\(--.*\)\?$/d' "$hypr/hyprland.lua"; echo "removed require(\"hypr.hyprwrlds-vimarchy\") from hyprland.lua"
fi
[[ -f "$hypr/hyprwrlds-vimarchy.lua" ]] && { cp "$hypr/hyprwrlds-vimarchy.lua" "$backups/"; rm "$hypr/hyprwrlds-vimarchy.lua"; echo "removed $hypr/hyprwrlds-vimarchy.lua"; }
command -v omarchy >/dev/null && omarchy plugin disable agf.hyprwrlds-vimarchy >/dev/null 2>&1 || true
[[ -d "$dest" ]] && { rm -rf "$dest"; echo "removed $dest"; }
hyprctl reload config-only >/dev/null 2>&1 || true
echo "done (backups: $backups)"
