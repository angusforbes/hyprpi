#!/usr/bin/env bash
# omnistation/panel-link.sh WL KIND (J555): the inside of a remote world's panel window when the panel runs on the LAPTOP. The panel
# is the same code as a local world's (mockups/KIND-tui.mjs), with HYPRPI_REMOTE_LINK=WL: its daemon calls go to that world's
# daemon through the world's link (omnistation/rlink.mjs, started here when it isn't running), and its desktop actions happen
# here, on the laptop (lib/tui/laptop.mjs). Typing, scrolling and clicks are local: no keystroke crosses the network.
# The panel restarts onto new code in place (exit 75, its state in a file), as the local launchers do; ^Q (exit 0) closes the window.
WL="${1^^}"; KIND="$2"
[[ "$WL" =~ ^[A-I]$ && "$KIND" =~ ^(search|room|agents|board)$ ]] || { echo "usage: panel-link.sh LETTER search|room|agents|board" >&2; exit 2; }
H="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# the world's link: started now, and checked every 30 s while this panel lives (it ends by itself when no panel needs it; one per
# world, so a second start just exits)
setsid -f node "$H/omnistation/rlink.mjs" "$WL" </dev/null >/dev/null 2>&1 || true
( while sleep 30; do setsid -f node "$H/omnistation/rlink.mjs" "$WL" </dev/null >/dev/null 2>&1 || true; done ) & keeper=$!
for _ in $(seq 20); do node "$H/omnistation/rlink.mjs" "$WL" --status 2>/dev/null | grep -q ": up" && break; sleep 0.25; done
f=$(mktemp -t "hyprpi-$KIND-$WL.XXXXXX"); trap 'rm -f "$f"; kill "$keeper" 2>/dev/null' EXIT
case "$KIND" in search) SV=HYPRPI_SEARCH_TUI_STATEFILE ;; room) SV=HYPRPI_ROOM_TUI_STATEFILE ;; board) SV=HYPRPI_BOARD_TUI_STATEFILE ;; agents) SV=HYPRPI_AGENTS_TUI_LOOP ;; esac
export HYPRPI_REMOTE_LINK="$WL"
unset HYPRPI_REMOTE_PANEL HYPRPI_LAPTOP_RELAY HYPRPI_AGENT_ID
while :; do
  if [[ "$KIND" == agents ]]; then env HYPRPI_AGENTS_TUI_LOOP=1 node "$H/mockups/agents-tui.mjs" "$WL"; else env "$SV=$f" node "$H/mockups/$KIND-tui.mjs" "$WL"; fi
  rc=$?; [[ $rc -eq 75 ]] || break
done
exit "$rc"
