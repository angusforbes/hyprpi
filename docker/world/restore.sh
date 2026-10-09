#!/usr/bin/env bash
# restore.sh: bring the sandboxed worlds back after a reboot, a crash or a power loss (J322, Angus: "our sandboxed
# World G was not restored").
#
#   docker/world/restore.sh            every world in ~/.config/hyprpi/worlds/*.json with "autostart": true
#   docker/world/restore.sh WORLD      just that one (whatever its autostart)
#   docker/world/restore.sh --install  enable the login unit (hyprpi-sandbox-restore.service), run once per login
#
# For each world: wait for the host hyprpi daemon; clear stale state a crash may have left inside the sandbox
# (daemon socket and lock, half-written registry temp files); world.sh start (relay, window helper, sandbox, inner
# daemon, gate, panels, shares watcher, the guide); then `hyprpi restore all` INSIDE the sandbox, which reopens the
# agents that were open when it went down on their own sessions, on their own workspaces, without taking focus;
# then the world's Doorman (sbx-relay.json entries with "doorman_for"). Idempotent: running it twice changes nothing.
# Log: ~/.local/state/hyprpi/sandboxes/restore.log
set -uo pipefail
H="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/hyprpi"
LOG="${XDG_STATE_HOME:-$HOME/.local/state}/hyprpi/sandboxes/restore.log"
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; }

if [[ "${1:-}" == "--install" ]]; then
  U="$HOME/.config/systemd/user/hyprpi-sandbox-restore.service"
  cat > "$U" <<EOF
[Unit]
Description=hyprpi: bring the sandboxed worlds back after login (J322)
After=graphical-session.target network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# give Hyprland and the host hyprpi daemon a moment; restore.sh waits for the daemon itself too
ExecStartPre=/usr/bin/sleep 20
ExecStart=$H/docker/world/restore.sh
TimeoutStartSec=900

[Install]
WantedBy=graphical-session.target
EOF
  systemctl --user daemon-reload && systemctl --user enable hyprpi-sandbox-restore.service >/dev/null && echo "installed and enabled: $U"
  exit 0
fi

worlds=()
if [[ -n "${1:-}" ]]; then worlds=("$1")
else
  for f in "$CFG"/worlds/*.json; do
    [[ -f "$f" ]] || continue
    [[ "$(jq -r '.autostart // false' "$f" 2>/dev/null)" == "true" ]] && worlds+=("$(basename "$f" .json)")
  done
fi
[[ ${#worlds[@]} -eq 0 ]] && { log "restore: no world has autostart on"; exit 0; }

# The host daemon must be up (the windows go through it); hyprpi starts it on first use, so ask it.
for i in $(seq 60); do "$H/bin/hyprpi" list >/dev/null 2>&1 && break; sleep 2; done

rc=0
for W in "${worlds[@]}"; do
  [[ "$W" =~ ^[a-z0-9-]{1,32}$ ]] || { log "restore: bad world name $W"; rc=1; continue; }
  SB="$(jq -r '.sandbox // empty' "$CFG/worlds/$W.json" 2>/dev/null)"; SB="${SB:-$W}"
  log "restore $W: starting (sandbox $SB)"
  # 1. stale state from a crash: only when the sandbox's inner daemon is NOT running (else it's a live world)
  if sbx ls 2>/dev/null | awk -v s="$SB" '$1==s && $4=="running" {f=1} END {exit !f}' && sbx exec "$SB" sh -c 'pgrep -f "^node .*/bin/hyprpi daemon" >/dev/null' 2>/dev/null; then
    log "restore $W: already running; only reopening what's missing"
  else
    sbx exec "$SB" sh -c 'r=$HOME/.hyprpi-g; rm -f $r/run/daemon.sock $r/run/daemon.lock; find $r/state -maxdepth 2 \( -name "*.tmp" -o -name "*.tmp.*" \) -mmin +1 -delete 2>/dev/null; true' >/dev/null 2>&1 \
      && log "restore $W: cleared stale daemon socket, lock and temp files"
  fi
  # 2. the world itself (idempotent)
  if ! "$H/docker/world/world.sh" start "$W" >>"$LOG" 2>&1; then log "restore $W: world.sh start failed"; rc=1; continue; fi
  # 3. its agents, on their own sessions and workspaces, no focus change
  out="$(sbx exec "$SB" sh -c ". $H/docker/world/g-env.sh; cd \"\$G_WORLD_DIR\" 2>/dev/null; hyprpi restore all 2>&1" 2>&1 | tail -3)"
  log "restore $W: agents: ${out//$'\n'/ | }"
  # 4. its Doorman, if it has one
  for D in $(jq -r --arg w "$SB" '.sandboxes[] | select(.doorman_for == $w) | .name' "$CFG/sbx-relay.json" 2>/dev/null); do
    systemctl --user is-active --quiet "hyprpi-doorman-$D" || { "$H/docker/doorman/doorman.sh" start "$D" >>"$LOG" 2>&1 && log "restore $W: Doorman $D started" || { log "restore $W: Doorman $D failed"; rc=1; }; }
  done
  log "restore $W: done"
done
exit $rc
