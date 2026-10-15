#!/bin/bash
# open.sh normal|quiet : the fixture session in a pi window on the private headless sway (wayland-2), scratch agent dir
M=$1; cp /tmp/j637/fixture.jsonl /tmp/j637/s-$M.jsonl
QUIET=""; EXT=""; [ "$M" = quiet ] && QUIET=1 && EXT="-e $HOME/Harness/.wt/j637/spikes/quiet-tools/quiet-tools.ts"
cd /tmp/j637/proj
WAYLAND_DISPLAY=wayland-2 setsid foot --app-id=j637$M -W 120x75 env PI_CODING_AGENT_DIR=/tmp/j637/agent-$M PI_QUIET_TOOLS=$QUIET \
  HYPRPI_AGENT_ID= HYPRPI_SOCKET=/tmp/j637/none.sock pi --no-extensions $EXT --session /tmp/j637/s-$M.jsonl >/tmp/j637/foot-$M.log 2>&1 </dev/null &
echo $!
