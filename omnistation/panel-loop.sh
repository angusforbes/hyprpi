#!/usr/bin/env bash
# omnistation/panel-loop.sh WL KIND SSH...: the inside of a remote world's panel window (J480). Runs the panel ON the remote
# machine (remote.sh panel KIND, against that world's own daemon) in this terminal over ssh -t, and comes back by itself:
# after a dropped link, an expired login (tsh login) or a stopped machine (brev start) it retries, so the window never has to
# be reopened by hand. ^Q in the panel (exit 0) closes the window.
# J543: the ssh runs through pty-relay.py, so what the panel does "on the desktop" (jump to an agent's window, open a link, bring up
# a panel, start an agent, paste the clipboard) happens HERE on the laptop, as in a local world; each run gets a fresh nonce the
# panel must send with its requests (HYPRPI_LAPTOP_RELAY there). Without python3 the panel runs as before (those actions then say so).
WL="$1"; KIND="$2"; shift 2
wl="${WL,,}"; WS="${HYPRPI_REMOTE_WS:?}"
RELAY="$(dirname "$(readlink -f "$0")")/pty-relay.py"
delay=3
while :; do
  start=$(date +%s)
  if command -v python3 >/dev/null && [[ -f "$RELAY" ]]; then
    nonce=$(od -An -N16 -tx1 /dev/urandom | tr -dc 0-9a-f)
    HYPRPI_RELAY_NONCE=$nonce python3 "$RELAY" "$WL" -- "$@" "HYPRPI_REMOTE_WS=$WS HYPRPI_LAPTOP_RELAY=$nonce bash ~/.hyprpi-$wl/remote.sh panel $KIND"
  else
    "$@" "HYPRPI_REMOTE_WS=$WS bash ~/.hyprpi-$wl/remote.sh panel $KIND"
  fi
  rc=$?
  (( rc == 0 )) && exit 0
  (( $(date +%s) - start > 60 )) && delay=3  # it ran for a while: a fresh drop, retry soon
  printf '\033[0m\033[2J\033[H'
  printf '\033]2;hyprpi-%s %s\007' "$([[ $KIND == agents ]] && echo router || echo "$KIND")" "$WL"  # keep the title the panel keys look for
  case $rc in
    4) msg="world $WL's daemon isn't running there yet (it starts with the first agent: world $WL new)" ;;
    255) msg="can't reach the remote machine (network, a stopped machine, or an expired login: tsh login / brev start)" ;;
    *) msg="the panel ended (exit $rc)" ;;
  esac
  printf '\n  📡 %s %s panel: %s.\n\n  Trying again in %s s by itself; close this window to stop.\n' "$WL" "$KIND" "$msg" "$delay"
  sleep "$delay"; delay=$(( delay * 2 > 30 ? 30 : delay * 2 ))
done
