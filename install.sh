#!/usr/bin/env bash
# Install / update hyprwrlds-vimarchy (needs hyprwrlds: https://github.com/angusforbes/hyprwrlds).
#   - Omarchy overlay plugin agf.hyprwrlds-vimarchy -> ~/.config/omarchy/plugins/
#   - hypr/hyprwrlds-vimarchy.lua (keys + double-tap) -> ~/.config/hypr/, required after hyprwrlds
# An already-loaded plugin may keep serving a cached copy of its QML until the
# shell restarts: run `omarchy-restart-shell` after updating.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
hypr="$HOME/.config/hypr"
dest="$HOME/.config/omarchy/plugins/agf.hyprwrlds-vimarchy"
backups="$HOME/.local/share/hyprwrlds-backups/$(date +%Y%m%d-%H%M%S)"

mkdir -p "$dest"
cp "$here/plugin/manifest.json" "$here/plugin/Overlay.qml" "$dest/"
cp "$here/Overview.qml" "$dest/Overview.qml"
echo "installed plugin to $dest"
omarchy plugin enable agf.hyprwrlds-vimarchy >/dev/null 2>&1 || true

cp "$here/hypr/hyprwrlds-vimarchy.lua" "$hypr/hyprwrlds-vimarchy.lua"
echo "installed $hypr/hyprwrlds-vimarchy.lua"
if ! grep -q 'require("hypr.hyprwrlds-vimarchy")' "$hypr/hyprland.lua"; then
  mkdir -p "$backups"; cp "$hypr/hyprland.lua" "$backups/hyprland.lua"
  if grep -q 'require("hypr.hyprwrlds")' "$hypr/hyprland.lua"; then
    sed -i 's|^require("hypr.hyprwrlds")$|require("hypr.hyprwrlds")\nrequire("hypr.hyprwrlds-vimarchy")|' "$hypr/hyprland.lua"
    echo "added require(\"hypr.hyprwrlds-vimarchy\") to hyprland.lua"
  else
    echo "NOTE: hyprwrlds is not installed; install it first, then re-run this script." >&2
  fi
fi
hyprctl reload config-only >/dev/null 2>&1 || true
