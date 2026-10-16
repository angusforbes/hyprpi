#!/bin/bash
# J722 (nss5a, NssAnswersCheck B4): bonk's exit status is the sound player's, so world-status (omnistation/world-status.mjs) can count
# a remote bonk/ding that failed to PLAY, not just a bonk script that failed to start. Fakes only: pw-play / paplay / wpctl / the toast
# commands are stubs on PATH, HOME is a temp folder, no hyprpi agent id, so nothing is played, shown or sent.
#   bash test/bonk-exit.sh [BONK]   (default ~/.local/bin/bonk; exit 0 = pass)
BONK=${1:-${BONK_BIN:-$HOME/.local/bin/bonk}}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home/.local/share/sounds" "$T/home/.local/state"
: > "$T/home/.local/share/sounds/bonk-knock.wav"
for c in wpctl notify-send omarchy-notification-send; do printf '#!/bin/sh\nexit 0\n' > "$T/bin/$c"; done
play() { printf '#!/bin/sh\nexit %s\n' "$2" > "$T/bin/$1"; chmod +x "$T/bin/$1"; }
chmod +x "$T/bin/"*
fails=0; ok() { if [[ $2 == 0 ]]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
run() { env -i HOME="$T/home" PATH="$T/bin:/usr/bin:/bin" BONK_NAME=Test bash "$BONK" "a message" >/dev/null 2>&1; }
play pw-play 0; play paplay 0; run; ok "a sound that plays: exit 0" $?
play pw-play 1; play paplay 0; run; ok "pw-play fails, paplay plays: exit 0" $?
play pw-play 1; play paplay 3; run; rc=$?; [[ $rc != 0 ]]; ok "both players fail: bonk exits non-zero ($rc), not the toast's 0" $?
grep -q "rc=3" "$T/home/.local/state/bonk.log"; ok "bonk.log records the player's rc" $?
[[ $fails == 0 ]] && echo "all ok" || { echo "$fails FAILED"; exit 1; }
