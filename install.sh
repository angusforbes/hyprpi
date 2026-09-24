#!/usr/bin/env bash
# Install/update the hyprwrlds-vimarchy Omarchy plugin from this repo.
# Note: an already-loaded plugin may keep serving a cached copy of its QML
# until the shell restarts (see ~/.pi/agent/notes/omarchy-bar-lessons.md §6-8).
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
dest="$HOME/.config/omarchy/plugins/agf.hyprwrlds-vimarchy"
mkdir -p "$dest"
cp "$here/plugin/manifest.json" "$here/plugin/Overlay.qml" "$dest/"
cp "$here/Overview.qml" "$dest/Overview.qml"
echo "installed to $dest"
