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
    # J322: sbx refuses to start when a saved mount's host folder is gone (moved or deleted while it was stopped):
    # drop those first (the shares watcher re-plans from config after the start).
    RT="$HOME/.local/state/sandboxes/sandboxes/sandboxd/runtimes/$SB.json"
    if ! sbx ls 2>/dev/null | awk -v s="$SB" '$1==s && $4=="running" {f=1} END {exit !f}' && [[ -f "$RT" ]]; then
      jq -r '.State.runtime_mounts[]? | "\(.host_path)\t\(.container_target)"' "$RT" | while IFS=$'\t' read -r hp ct; do
        [[ -e "$hp" ]] || { sbx umount "$SB" "$hp:$ct" >/dev/null 2>&1 && echo "world.sh: dropped the saved mount of a missing folder: $hp" >&2; }
      done
    fi
    sbx exec "$SB" true >/dev/null   # starts the sandbox (mounts are restored by sbx)
    # J322: apply the shares BEFORE anything inside runs from hyprpi's checkout: after a move (J317 ~/Work → ~/Harness)
    # the saved mounts no longer include it, and only the share plan puts it back.
    node "$H/docker/world/shares.mjs" apply "$WORLD" >/dev/null || echo "world.sh: shares apply failed" >&2
    in_sb 'pgrep -ax node | grep -q "/bin/hyprpi daemon" || { cd "$G_WORLD_DIR"; setsid -f sh -c "exec node $G_HOST_HYPRPI/bin/hyprpi daemon" >> $HOME/.hyprpi-g/daemon.log 2>&1 < /dev/null; sleep 3; }'
    in_sb 'pgrep -ax node | grep -q "/g-gate[.]mjs" || HYPRPI_GATE_WORKSPACE='"$HI"' setsid -f sh -c "while :; do node $G_HOST_HYPRPI/docker/world/g-gate.mjs; sleep 3; done" >> $HOME/.hyprpi-g/gate.log 2>&1 < /dev/null'
    in_sb 'for p in agents-tui room-tui board-tui search-tui; do pgrep -f "$p.mjs" >/dev/null || G_WS='"$HI"' setsid -f $G_HOST_HYPRPI/mockups/$p G >/dev/null 2>&1 < /dev/null; done'
    # J307: folder shares from config + the host card (re-applied on changes), the inner guide and the sandbox note
    systemctl --user is-active --quiet "hyprpi-$WORLD-shares" || systemd-run --user --quiet --unit="hyprpi-$WORLD-shares" --collect --property=Restart=on-failure node "$H/docker/world/shares.mjs" watch "$WORLD"
    sbx exec "$SB" sh -c 'mkdir -p ~/.local/bin ~/.pi/agent/skills/sandbox-guide' >/dev/null
    sbx cp "$H/docker/guide/sandbox-guide" "$SB:/home/agent/.local/bin/sandbox-guide" >/dev/null && sbx exec "$SB" chmod +x /home/agent/.local/bin/sandbox-guide
    sbx cp "$H/docker/guide/SKILL.md" "$SB:/home/agent/.pi/agent/skills/sandbox-guide/SKILL.md" >/dev/null
    sbx cp "$H/docker/guide/AGENTS-sandbox.md" "$SB:/home/agent/.hyprpi-g/sandbox-note.md" >/dev/null
    sbx exec "$SB" sh -c 'f=~/.pi/agent/AGENTS.md; touch $f; sed -i "/<!-- hyprpi sandbox note/,/<!-- end hyprpi sandbox note -->/d" $f; cat ~/.hyprpi-g/sandbox-note.md >> $f' >/dev/null
    [ -x "$H/docker/world/ro-retest.sh" ] && { "$H/docker/world/ro-retest.sh" --if-new >/dev/null 2>&1 & }   # J307 (7a): re-test read-only after an sbx update
    in_sb 'hyprpi list' ;;
  new)
    NAME="${2:?usage: world.sh new NAME}"
    [[ "$NAME" =~ ^[A-Za-z][A-Za-z0-9_-]{0,30}$ ]] || { echo "world.sh: bad agent name" >&2; exit 2; }
    # the first of the world's workspaces (except the last, the panels') with none of its windows, as the helper sees them
    WS="$(in_sb 'hyprctl -j clients' | jq --argjson lo "$LO" --argjson hi "$HI" '[.[].workspace.id] as $u | [range($lo; $hi)] | map(select(. as $w | $u | index($w) | not)) | first // $lo')"
    in_sb "cd \"\$G_WORLD_DIR\" && hyprpi new --workspace $WS --no-focus --cwd \"\$G_WORLD_DIR\" --name $NAME" ;;
  stop)
    node "$H/docker/sbx-relay.mjs" clear "$SB" >/dev/null 2>&1 || true   # J274: this world's "allow similar" rules end with it
    for a in $(node "$H/docker/world/world-helper.mjs" windows "$WORLD"); do   # only windows this world owns (review #7)
      hyprctl dispatch "hl.dsp.window.close({ window = \"address:$a\" })" >/dev/null 2>&1 || true
    done
    systemctl --user stop "hyprpi-$WORLD-shares" >/dev/null 2>&1 || true   # J307
    sbx stop "$SB" >/dev/null 2>&1 || true
    node "$H/docker/world/world-helper.mjs" stop "$WORLD" 2>/dev/null || true
    echo "world $WORLD stopped (the relay keeps running: docker/sbx-relay.mjs stop)" ;;
  status)
    systemctl --user is-active "hyprpi-$WORLD-helper" hyprpi-sbx-relay || true
    sbx ls 2>/dev/null | awk -v s="$SB" 'NR==1 || $1==s'
    # J279: only look inside when it is already running (sbx exec would start a stopped sandbox)
    if sbx ls 2>/dev/null | awk -v s="$SB" '$1==s && $4=="running" {f=1} END {exit !f}'; then in_sb 'hyprpi list' 2>/dev/null || true
    else echo "($SB is not running: not started just to look; start: docker/world/world.sh start)"; fi ;;
  *) echo "usage: world.sh start|new NAME|stop|status [WORLD]" >&2; exit 2 ;;
esac
