#!/usr/bin/env bash
# sbx-daemon.sh: keep sbx's background daemon (sandboxd) in its OWN systemd user unit, hyprpi-sandboxd.service (J403).
#
# Why: any `sbx` command starts sandboxd when it isn't running, as a child of whatever ran it. After the battery restore
# of 2026-10-10 it was started by restore.sh, inside hyprpi-sandbox-restore.service (a oneshot); when that unit
# finished, systemd killed everything left in its cgroup, sandboxd too, and every sandbox window closed and world-g's
# container restarted. The next sbx call then started it inside the Doorman's unit, equally fragile.
#
#   docker/sbx-daemon.sh ensure     start the unit unless sandboxd already answers (call before the first sbx command)
#   docker/sbx-daemon.sh install    write and enable the unit file (it starts at login; no start now)
# Callers: restore.sh, world.sh start, doorman.sh (in the Doorman unit, before each run), world-helper.mjs (before a
# window's sbx exec) and sbx-relay.mjs (before a research unit): each would otherwise start sandboxd in its own cgroup.
#   docker/sbx-daemon.sh where      which cgroup the running sandboxd is in ("own unit" or not)
set -uo pipefail
U=hyprpi-sandboxd.service
F="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$U"
SBX="$(command -v sbx || echo "$HOME/.local/bin/sbx")"

install_unit() {
  mkdir -p "$(dirname "$F")"
  local want
  want="[Unit]
Description=hyprpi: sbx's sandbox daemon (sandboxd) in its own unit, so no other unit's stop or exit takes it down (J403)

[Service]
Type=simple
ExecStart=$SBX daemon start
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=default.target
"
  [[ -f "$F" && "$(cat "$F"; echo .)" == "$want." ]] && return 0  # (the dot keeps the trailing newline in the compare)
  printf '%s' "$want" > "$F" && systemctl --user daemon-reload && systemctl --user enable "$U" >/dev/null 2>&1
}

SOCK="${XDG_STATE_HOME:-$HOME/.local/state}/sandboxes/sandboxes/sandboxd/sandboxd.sock"
# fast (~20 ms): sandboxd's own health route on its socket; `sbx daemon status` as the fallback (~2 s)
running() {
  if command -v curl >/dev/null; then [[ "$(curl -s -m 3 --unix-socket "$SOCK" -o /dev/null -w '%{http_code}' http://sandboxd/daemon/health 2>/dev/null)" == 200 ]]
  else "$SBX" daemon status 2>/dev/null | grep -q '^Status: running'; fi
}

case "${1:-ensure}" in
  install) install_unit ;;
  where)
    p="$(pgrep -f '^[^ ]*/sbx daemon start$' | head -1)"
    [[ -z "$p" ]] && { echo "not running"; exit 1; }
    cg="$(cut -d: -f3 "/proc/$p/cgroup")"
    [[ "$cg" == */"$U" ]] && echo "own unit ($cg)" || echo "elsewhere: $cg"
    ;;
  ensure)
    install_unit
    running && exit 0
    systemctl --user start "$U" || exit 1
    for _ in $(seq 30); do running && exit 0; sleep 1; done
    echo "sbx-daemon: $U started but sandboxd doesn't answer" >&2; exit 1
    ;;
  *) echo "usage: sbx-daemon.sh ensure|install|where" >&2; exit 2 ;;
esac
