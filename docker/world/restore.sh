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
After=graphical-session.target

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

# J403: sandboxd must NOT be started by the sbx calls below: it would land in this oneshot unit's cgroup and be killed
# when the unit finishes, closing every sandbox window (the 2026-10-10 battery restore). Its own unit keeps it.
"$H/docker/sbx-daemon.sh" ensure && log "restore: sandboxd: $("$H/docker/sbx-daemon.sh" where)" || log "restore: couldn't start hyprpi-sandboxd.service; sbx will start sandboxd itself (fragile)"

rc=0
for W in "${worlds[@]}"; do
  [[ "$W" =~ ^[a-z0-9-]{1,32}$ && -f "$CFG/worlds/$W.json" ]] || { log "restore: no such world: $W (no $CFG/worlds/$W.json)"; rc=1; continue; }
  SB="$(jq -r '.sandbox // empty' "$CFG/worlds/$W.json" 2>/dev/null)"; SB="${SB:-$W}"
  log "restore $W: starting (sandbox $SB)"
  # 0. (Lenswatch 1e) sbx won't start a sandbox whose saved mounts point at missing folders, so drop those BEFORE the
  #    first sbx exec below; otherwise the stale-file cleanup would silently fail to start it. (world.sh start does
  #    the same for its own callers.)
  RT="$HOME/.local/state/sandboxes/sandboxes/sandboxd/runtimes/$SB.json"
  if ! sbx ls 2>/dev/null | awk -v s="$SB" '$1==s && $4=="running" {f=1} END {exit !f}' && [[ -f "$RT" ]]; then
    jq -r '.State.runtime_mounts[]? | "\(.host_path)\t\(.container_target)"' "$RT" | while IFS=$'\t' read -r hp ct; do
      [[ -e "$hp" ]] || { sbx umount "$SB" "$hp:$ct" >/dev/null 2>&1 && log "restore $W: dropped the saved mount of a missing folder: $hp"; }
    done
  fi
  # 1. stale state from a crash: only when the sandbox's inner daemon is NOT running (else it's a live world)
  #    (Lenswatch J322b) "running" = a daemon process (any node path) OR a socket that answers; stale files are
  #    deleted only inside the sandbox, only when neither holds, and the socket is re-tested right before deleting.
  if sbx ls 2>/dev/null | awk -v s="$SB" '$1==s && $4=="running" {f=1} END {exit !f}' && sbx exec "$SB" sh -c "pgrep -ax node | grep -q '/bin/hyprpi daemon' || { . $H/docker/world/g-env.sh; timeout 10 hyprpi list >/dev/null 2>&1; }" 2>/dev/null; then
    log "restore $W: already running; only reopening what's missing"
  else
    if sbx exec "$SB" sh -c ". $H/docker/world/g-env.sh 2>/dev/null; pgrep -ax node | grep -q '/bin/hyprpi daemon' && exit 3; [ -S \$HOME/.hyprpi-g/run/daemon.sock ] && timeout 10 hyprpi list >/dev/null 2>&1 && exit 3; exit 0" >/dev/null 2>&1 && sbx exec "$SB" sh -c 'r=$HOME/.hyprpi-g; rm -f $r/run/daemon.sock $r/run/daemon.lock; find $r/state -maxdepth 2 \( -name "*.tmp" -o -name "*.tmp.*" \) -mmin +1 -delete 2>/dev/null; true' >/dev/null 2>&1; then
      log "restore $W: cleared stale daemon socket, lock and temp files"
    else log "restore $W: couldn't clear stale files (sandbox didn't start?); world.sh start will report why"; fi
  fi
  # 1b. (J322 re-login) host units that talk to Hyprland but were started under an EARLIER Hyprland (a logout/login
  #     starts a new one; the user manager and its units live on) can't open or find windows any more: their
  #     hyprctl calls fail. Stop those; world.sh start / doorman.sh start below start them again with this login's.
  HIS_NOW="${HYPRLAND_INSTANCE_SIGNATURE:-$(systemctl --user show-environment | sed -n 's/^HYPRLAND_INSTANCE_SIGNATURE=//p')}"
  for U in "hyprpi-$W-helper" hyprpi-sbx-relay "hyprpi-$W-shares" $(jq -r --arg w "$SB" '.sandboxes[] | select(.doorman_for == $w) | "hyprpi-doorman-" + .name' "$CFG/sbx-relay.json" 2>/dev/null); do
    P="$(systemctl --user show "$U" -p MainPID --value 2>/dev/null)"; [[ "$P" =~ ^[1-9][0-9]*$ ]] || continue
    HIS_U="$(tr '\0' '\n' < "/proc/$P/environ" 2>/dev/null | sed -n 's/^HYPRLAND_INSTANCE_SIGNATURE=//p')"
    if [[ -n "$HIS_NOW" && -n "$HIS_U" && "$HIS_U" != "$HIS_NOW" ]]; then
      if [[ "$U" == hyprpi-sbx-relay && -n "$(node "$H/docker/sbx-relay.mjs" pending 2>/dev/null | grep -v '^nothing waiting')" ]]; then
        log "restore $W: $U is from an earlier login but holds messages for Angus; restarting it anyway (they're on disk)"
      fi
      systemctl --user stop "$U" && log "restore $W: stopped $U (started under an earlier Hyprland; restarted below)"
    fi
  done
  # 2. the world itself (idempotent)
  if ! "$H/docker/world/world.sh" start "$W" >>"$LOG" 2>&1; then log "restore $W: world.sh start failed"; rc=1; continue; fi
  # 3. its agents, on their own sessions and workspaces, no focus change
  out="$(sbx exec "$SB" sh -c ". $H/docker/world/g-env.sh; cd \"\$G_WORLD_DIR\" 2>/dev/null; hyprpi restore all 2>&1" 2>&1 | tail -3)"
  log "restore $W: agents: ${out//$'\n'/ | }"
  # J403: remember which agents are open right after the restore (stable ids, the last column of `hyprpi list`, not
  # display names: J403Test), so the check below can see one gone again
  declare -g "BACK_${W//-/_}=$(sbx exec "$SB" sh -c ". $H/docker/world/g-env.sh; timeout 15 hyprpi list 2>/dev/null" 2>/dev/null | awk -F'\t' 'NF>=5 && $NF ~ /^[A-Za-z0-9_.-]{3,64}$/ && $NF !~ /^(g-|sbx-)/ {print $NF}' | tr '\n' ' ')"
  [[ "$out" == *"not restored"* ]] && { log "restore $W: some agents did not come back"; rc=1; }
  # 4. its Doorman, if it has one
  for D in $(jq -r --arg w "$SB" '.sandboxes[] | select(.doorman_for == $w) | .name' "$CFG/sbx-relay.json" 2>/dev/null); do
    systemctl --user is-active --quiet "hyprpi-doorman-$D" || { "$H/docker/doorman/doorman.sh" start "$D" >>"$LOG" 2>&1 && log "restore $W: Doorman $D started" || { log "restore $W: Doorman $D failed"; rc=1; }; }
  done
  log "restore $W: done"
done

# J403: check ~30 s after the restore that each world is still up (sandbox running, its daemon answering, no agent
# left to restore); re-run it once if not, and tell Angus with a toast if that doesn't help.
healthy() { # $1 world → 0 when up
  local SB; SB="$(jq -r '.sandbox // empty' "$CFG/worlds/$1.json" 2>/dev/null)"; SB="${SB:-$1}"
  sbx ls 2>/dev/null | awk -v s="$SB" '$1==s && $4=="running" {f=1} END {exit !f}' || { why="sandbox $SB not running"; return 1; }
  local l; l="$(sbx exec "$SB" sh -c ". $H/docker/world/g-env.sh; timeout 15 hyprpi restore all --list 2>&1" 2>&1 | tail -4)"
  [[ "$l" == *"To restore (all): nothing"* ]] || { why="not all back: ${l//$'\n'/ | }"; return 1; }
  # and every agent the restore brought back is still open (a window killed while the daemon lived counts as closed)
  local v="BACK_${1//-/_}" live n; live="$(sbx exec "$SB" sh -c ". $H/docker/world/g-env.sh; timeout 15 hyprpi list 2>&1" 2>&1)"
  for n in ${!v:-}; do awk -F'\t' -v id="$n" 'NF>=5 && $NF==id {f=1} END {exit !f}' <<<"$live" || { why="agent $n is no longer open"; return 1; }; done
  return 0
}
for W in "${worlds[@]}"; do
  [[ "$W" =~ ^[a-z0-9-]{1,32}$ && -f "$CFG/worlds/$W.json" ]] || continue
  sleep "${HYPRPI_RESTORE_CHECK_SECS:-30}"
  if healthy "$W"; then log "restore $W: check after 30 s: up (sandboxd: $("$H/docker/sbx-daemon.sh" where 2>&1))"; continue; fi
  log "restore $W: check after 30 s FAILED ($why); restoring once more"
  "$H/docker/sbx-daemon.sh" ensure >/dev/null 2>&1
  "$H/docker/world/world.sh" start "$W" >>"$LOG" 2>&1
  SB="$(jq -r '.sandbox // empty' "$CFG/worlds/$W.json" 2>/dev/null)"; SB="${SB:-$W}"
  out="$(sbx exec "$SB" sh -c ". $H/docker/world/g-env.sh; cd \"\$G_WORLD_DIR\" 2>/dev/null; hyprpi restore all 2>&1" 2>&1 | tail -3)"
  log "restore $W: second try: ${out//$'\n'/ | }"
  sleep 20
  if healthy "$W"; then log "restore $W: up after the second try"
  else
    log "restore $W: still not back after the second try ($why)"; rc=1
    notify-send -a hyprpi -u critical "World ${W#world-} didn't come back" "$why. Log: $LOG" 2>/dev/null || true
  fi
done
exit $rc
