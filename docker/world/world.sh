#!/usr/bin/env bash
# world.sh: start / stop a sandboxed hyprpi world (J262, @pidocker). World G = one Docker Sandboxes (sbx)
# sandbox running its own hyprpi daemon, with G's agents, panels and Thoughts-G inside it; on the host, the
# window helper (G's windows only) and the drop-box relay (the gated link to the other worlds).
#
#   docker/world/world.sh start [WORLD]     relay + helper on the host; sandbox, inner daemon, gate and G's
#                                           panels inside (agents: open them from G's agents panel or with
#                                           `world.sh new NAME`)
#   docker/world/world.sh new NAME [WORLD]  a new agent in the world (on its next free workspace)
#   docker/world/world.sh stop [WORLD]      close G's windows, stop the sandbox, the helper (not the relay,
#                                           which other sandboxes may use: docker/sbx-relay.mjs stop)
#   docker/world/world.sh status [WORLD]
# Setup once: docker/README.md ("A sandboxed world").
set -euo pipefail
H="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
CMD="${1:-status}"; WORLD="${3:-${2:-world-g}}"
[[ "$CMD" == new ]] && WORLD="${3:-world-g}"
[[ "$WORLD" =~ ^[a-z0-9-]{1,32}$ ]] || { echo "world.sh: bad world name" >&2; exit 2; }
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/hyprpi/worlds/$WORLD.json"
SB="$(jq -r .sandbox "$CONF")"; LO="$(jq -r '.workspaces[0]' "$CONF")"; HI="$(jq -r '.workspaces[1]' "$CONF")"
WSDIR="$(jq -r .workspace "$CONF" | sed "s#^~#$HOME#")"; HIN="$(jq -r .inbox "$CONF" | sed "s#^~#$HOME#")"
MIN="$(jq -r --arg s "$SB" '.sandboxes[] | select(.name == $s) | .inbox' "${XDG_CONFIG_HOME:-$HOME/.config}/hyprpi/sbx-relay.json" | sed "s#^~#$HOME#")"
[[ "$H$WSDIR$HIN$MIN" =~ ^[A-Za-z0-9/._-]+$ ]] || { echo "world.sh: unexpected characters in the configured paths" >&2; exit 2; }
# The sandbox sees host folders at their host paths; it learns them from ~/.hyprpi-g/host.env (read by g-env.sh).
HE="G_HOST_HYPRPI=$H\nG_WORLD_DIR=$WSDIR\nG_HYPR_INBOX=$HIN\nG_MSG_INBOX=$MIN"
INNER=". $H/docker/world/g-env.sh"
in_sb() { sbx exec "$SB" sh -c "mkdir -p ~/.hyprpi-g && printf '$HE\\n' > ~/.hyprpi-g/host.env; $INNER; $1"; }

case "$CMD" in
  start)
    systemctl --user is-active --quiet hyprpi-sbx-relay || node "$H/docker/sbx-relay.mjs" start
    systemctl --user is-active --quiet "hyprpi-$WORLD-helper" || node "$H/docker/world/world-helper.mjs" start "$WORLD"
    in_sb true >/dev/null   # starts the sandbox (mounts are restored by sbx)
    in_sb 'pgrep -f "hyprpi daemon" >/dev/null || { cd "$G_WORLD_DIR"; setsid -f node $G_HOST_HYPRPI/bin/hyprpi daemon >> $HOME/.hyprpi-g/daemon.log 2>&1 < /dev/null; sleep 3; }'
    in_sb 'pgrep -f g-gate.mjs >/dev/null || HYPRPI_GATE_WORKSPACE='"$HI"' setsid -f sh -c "while :; do node $G_HOST_HYPRPI/docker/world/g-gate.mjs; sleep 3; done" >> $HOME/.hyprpi-g/gate.log 2>&1 < /dev/null'
    in_sb 'for p in agents-tui room-tui board-tui search-tui; do pgrep -f "$p.mjs" >/dev/null || G_WS='"$HI"' setsid -f $G_HOST_HYPRPI/mockups/$p G >/dev/null 2>&1 < /dev/null; done'
    in_sb 'hyprpi list' ;;
  new)
    NAME="${2:?usage: world.sh new NAME}"
    [[ "$NAME" =~ ^[A-Za-z][A-Za-z0-9_-]{0,30}$ ]] || { echo "world.sh: bad agent name" >&2; exit 2; }
    # the first of the world's workspaces (except the last, the panels') with none of its windows, as the helper sees them
    WS="$(in_sb 'hyprctl -j clients' | jq --argjson lo "$LO" --argjson hi "$HI" '[.[].workspace.id] as $u | [range($lo; $hi)] | map(select(. as $w | $u | index($w) | not)) | first // $lo')"
    in_sb "cd \"\$G_WORLD_DIR\" && hyprpi new --workspace $WS --no-focus --cwd \"\$G_WORLD_DIR\" --name $NAME" ;;
  stop)
    node "$H/docker/sbx-relay.mjs" clear "$WORLD" >/dev/null 2>&1 || true   # J274: this world's "allow similar" rules end with it
    for a in $(node "$H/docker/world/world-helper.mjs" windows "$WORLD"); do   # only windows this world owns (review #7)
      hyprctl dispatch "hl.dsp.window.close({ window = \"address:$a\" })" >/dev/null 2>&1 || true
    done
    sbx stop "$SB" >/dev/null 2>&1 || true
    node "$H/docker/world/world-helper.mjs" stop "$WORLD" 2>/dev/null || true
    echo "world $WORLD stopped (the relay keeps running: docker/sbx-relay.mjs stop)" ;;
  status)
    systemctl --user is-active "hyprpi-$WORLD-helper" hyprpi-sbx-relay || true
    sbx ls 2>/dev/null | awk -v s="$SB" 'NR==1 || $1==s'
    in_sb 'hyprpi list' 2>/dev/null || true ;;
  *) echo "usage: world.sh start|new NAME|stop|status [WORLD]" >&2; exit 2 ;;
esac
