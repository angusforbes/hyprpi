#!/bin/bash
# Remove hyprpi voice-routing's install: the links into this checkout, the two units, the bar widget link
# and the Pi extension link. Keeps the data folder (venv, models) and ~/.config/voice-listen/config.json
# unless --purge.
set -u
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA="${VOICE_ROUTING_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/voice-routing}"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
ours() { [[ -L $1 && $(readlink -f "$1") == "$HERE"/* ]]; }   # only links that point into this checkout
systemctl --user disable --now voice-listen.service voice-whisper.service 2>/dev/null
rm -f "$CFG/systemd/user/voice-listen.service" "$CFG/systemd/user/voice-whisper.service"; systemctl --user daemon-reload
for f in "$BIN"/voice-agent "$BIN"/voice-agent-target "$BIN"/voice-listen "$BIN"/voice-whisper-client \
         "$HOME/.pi/agent/extensions/voice-switch.ts" "$CFG/omarchy/plugins/herdr.voice"; do
  if ours "$f"; then rm -f "$f"; elif [[ -e $f ]]; then echo "left $f (not a link into this checkout)"; fi
done
command -v omarchy-shell >/dev/null && omarchy-shell shell setPluginEnabled herdr.voice false >/dev/null 2>&1
rm -rf "${XDG_RUNTIME_DIR:-/tmp}/voice-agent" "${XDG_RUNTIME_DIR:-/tmp}/voice-listen"
[[ ${1:-} == --purge ]] && rm -rf "$DATA" "$CFG/voice-listen"
echo "voice-routing removed$([[ ${1:-} == --purge ]] && echo ', data and config too'). Remove your key bindings by hand."
