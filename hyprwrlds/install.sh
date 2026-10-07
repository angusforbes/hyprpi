#!/usr/bin/env bash
# Install / update hyprwrlds on an Omarchy system (Hyprland 0.56+ Lua config).
#   - copies hypr/hyprwrlds.lua to ~/.config/hypr/
#   - adds require("hypr.hyprwrlds") to ~/.config/hypr/hyprland.lua (after hypr.bindings)
#   - installs the bar widget plugin agf.hyprwrlds and swaps it in for omarchy.workspaces
# Backups of edited files go to ~/.local/share/hyprwrlds-backups/.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
hypr="$HOME/.config/hypr"
plugins="$HOME/.config/omarchy/plugins"
shelljson="$HOME/.config/omarchy/shell.json"
backups="$HOME/.local/share/hyprwrlds-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backups"

cp "$here/hypr/hyprwrlds.lua" "$hypr/hyprwrlds.lua"
echo "installed $hypr/hyprwrlds.lua"

if ! grep -q 'require("hypr.hyprwrlds")' "$hypr/hyprland.lua"; then
  cp "$hypr/hyprland.lua" "$backups/hyprland.lua"
  if grep -q 'require("hypr.bindings")' "$hypr/hyprland.lua"; then
    sed -i 's|^require("hypr.bindings")$|require("hypr.bindings")\nrequire("hypr.hyprwrlds")|' "$hypr/hyprland.lua"
  else
    printf '\nrequire("hypr.hyprwrlds")\n' >>"$hypr/hyprland.lua"
  fi
  echo "added require(\"hypr.hyprwrlds\") to hyprland.lua"
fi

# Bar widget (backups must stay OUTSIDE the plugins dir: the shell scans it).
mkdir -p "$plugins/agf.hyprwrlds"
cp "$here/omarchy-plugin/agf.hyprwrlds/"* "$plugins/agf.hyprwrlds/"
omarchy plugin enable agf.hyprwrlds >/dev/null 2>&1 || true
if [[ -f $shelljson ]] && jq -e '.bar.layout.left[]? | select(.id=="omarchy.workspaces")' "$shelljson" >/dev/null; then
  cp "$shelljson" "$backups/shell.json"
  jq '(.bar.layout.left) |= map(if .id=="omarchy.workspaces" then {"id":"agf.hyprwrlds"} else . end)' "$shelljson" >"$shelljson.tmp" && mv "$shelljson.tmp" "$shelljson"
  echo "bar: replaced omarchy.workspaces with agf.hyprwrlds"
fi

hyprctl reload config-only >/dev/null && echo "hyprland config reloaded" || true
echo "done (backups: $backups)"
