#!/usr/bin/env bash
# remote.sh: hyprpi headless on a remote Linux machine (J469, world H: "agents running on a remote server, seen here").
# Runs ON the remote machine. The laptop sends it over ssh (omnistation/world-h), so nothing has to be installed there first:
#   ssh HOST "mkdir -p ~/.hyprpi-h && cat > ~/.hyprpi-h/remote.sh" < omnistation/remote.sh; ssh HOST bash ~/.hyprpi-h/remote.sh install
#
#   remote.sh install            clone (or update) hyprpi into ~/hyprpi from its public repo; check node 22+ and pi (install pi
#                                into ~/.local with npm if it's missing, the version hyprpi is tested with)
#   remote.sh start [NAME]       start the headless daemon and one agent NAME (default alpha) in tmux; both outlive ssh
#   remote.sh attach [NAME]      attach this terminal to agent NAME's pi (what a world H window runs); detach = close the window
#   remote.sh status             daemon and agents, as hyprpi sees them
#   remote.sh stop [NAME|all]    stop an agent (its session file stays, so `start NAME` resumes it), or everything
#
# Headless: no Hyprland, no panels, no windows. The daemon and each agent run in their own tmux session (hyprpi-h-*), so an ssh
# disconnect (or the laptop sleeping) leaves them running; `attach` reconnects to the same pi and session. State lives in
# ~/.hyprpi-h (daemon socket, registry), separate from any desktop hyprpi on that machine. Nothing here names a particular site.
set -euo pipefail
REPO_URL="${HYPRPI_REPO_URL:-https://github.com/angusforbes/hyprpi.git}"
DIR="${HYPRPI_DIR:-$HOME/hyprpi}"
ROOT="$HOME/.hyprpi-h"
WORK="${HYPRPI_H_WORK:-$HOME/work}"
export HYPRPI_STATE="$ROOT/state" HYPRPI_SOCKET="$ROOT/run/daemon.sock" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$ROOT/run}" HYPRPI_NO_ADOPT=1
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
unset HYPRLAND_INSTANCE_SIGNATURE WAYLAND_DISPLAY DISPLAY  # headless: never a desktop, even if one is around
# the laptop's terminal type may be unknown here (kitty's xterm-kitty): tmux needs one it knows
infocmp "${TERM:-dumb}" >/dev/null 2>&1 || export TERM=xterm-256color
# a machine whose outbound TLS is inspected by its own CA: node (pi, hyprpi) must trust the system bundle, as curl does
[[ -z "${NODE_EXTRA_CA_CERTS:-}" && -r /etc/ssl/certs/ca-certificates.crt ]] && export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
cmd="${1:-status}"; NAME="${2:-alpha}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{0,30}$ || "$NAME" == all ]] || { echo "remote.sh: a name is lowercase letters, digits and -" >&2; exit 2; }
mkdir -p "$ROOT/state" "$ROOT/run" "$WORK"; chmod 700 "$ROOT" "$ROOT/run"
hp() { node "$DIR/bin/hyprpi" "$@"; }
need() { command -v "$1" >/dev/null || { echo "remote.sh: $1 isn't installed here ($2)" >&2; exit 3; }; }
case "$cmd" in
  install)
    need git "needed to fetch hyprpi"; need node "hyprpi needs node 22+"; need tmux "keeps the agents running when ssh drops"
    major=$(node -p 'process.versions.node.split(".")[0]'); (( major >= 22 )) || { echo "remote.sh: node $major is too old (22+)" >&2; exit 3; }
    if [[ -d "$DIR/.git" ]]; then git -C "$DIR" pull -q --ff-only
    elif [[ -f "$DIR/bin/hyprpi" ]]; then :  # copied from the laptop (world-h setup), e.g. where the git host isn't reachable
    else git clone -q "$REPO_URL" "$DIR"; fi
    want=$(cat "$DIR/docker/PI_VERSION" 2>/dev/null || echo latest)
    if ! command -v pi >/dev/null; then need npm "to install pi"; npm install -g --prefix "$HOME/.local" "@earendil-works/pi-coding-agent@$want" >/dev/null; fi
    # headless: agents run in tmux, never in a desktop terminal; hyprpi only needs a terminalCommand set to accept that
    c="${XDG_CONFIG_HOME:-$HOME/.config}/hyprpi/config.json"; mkdir -p "$(dirname "$c")"
    [[ -f "$c" ]] || printf '{\n  "//terminalCommand": "headless (omnistation/remote.sh): agents run in tmux; no desktop terminal is ever opened",\n  "terminalCommand": ["tmux"]\n}\n' > "$c"
    echo "hyprpi $(git -C "$DIR" log -1 --format=%h 2>/dev/null || cat "$DIR/.version" 2>/dev/null) in $DIR; pi $(pi --version 2>/dev/null | head -1); node $(node -v)"
    echo "next: log pi in once (run \`pi\` here, /login), then: remote.sh start" ;;
  start)
    tmux has-session -t hyprpi-h-daemon 2>/dev/null || tmux new-session -d -s hyprpi-h-daemon "$(declare -p HYPRPI_STATE HYPRPI_SOCKET XDG_RUNTIME_DIR HYPRPI_NO_ADOPT PATH ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS} | sed 's/^declare -x /export /'); exec node $DIR/bin/hyprpi daemon"
    for _ in $(seq 30); do [[ -S "$HYPRPI_SOCKET" ]] && break; sleep 0.5; done
    [[ -S "$HYPRPI_SOCKET" ]] || { echo "remote.sh: the daemon didn't start (tmux attach -t hyprpi-h-daemon shows why)" >&2; exit 4; }
    if tmux has-session -t "hyprpi-h-$NAME" 2>/dev/null; then echo "agent $NAME already runs"; exit 0; fi
    # its pi session is resumed when it ran before (the newest session of this agent id), else a new one starts
    sess=$(ls -t "$ROOT/sessions/$NAME"/*.jsonl 2>/dev/null | head -1 || true)
    tmux new-session -d -s "hyprpi-h-$NAME" -c "$WORK" "$(declare -p HYPRPI_STATE HYPRPI_SOCKET XDG_RUNTIME_DIR HYPRPI_NO_ADOPT PATH ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS} | sed 's/^declare -x /export /'); exec node $DIR/bin/hyprpi new --id h-$NAME --name $NAME --cwd $WORK -- --session-dir $ROOT/sessions/$NAME ${sess:+--session $sess}"
    sleep 2; tmux has-session -t "hyprpi-h-$NAME" 2>/dev/null && echo "agent $NAME started (tmux session hyprpi-h-$NAME)" || { echo "remote.sh: agent $NAME exited at once" >&2; exit 4; } ;;
  attach)
    tmux has-session -t "hyprpi-h-$NAME" 2>/dev/null || bash "$ROOT/remote.sh" start "$NAME" >/dev/null
    exec tmux attach -t "hyprpi-h-$NAME" ;;
  status)
    tmux ls 2>/dev/null | grep '^hyprpi-h-' || echo "nothing running"
    [[ -S "$HYPRPI_SOCKET" ]] && hp list 2>/dev/null | head -20 || true ;;
  stop)
    if [[ "$NAME" == all ]]; then for s in $(tmux ls -F '#S' 2>/dev/null | grep '^hyprpi-h-'); do tmux kill-session -t "$s"; done; echo "stopped all"
    else tmux kill-session -t "hyprpi-h-$NAME" 2>/dev/null && echo "stopped $NAME (its session stays: start $NAME resumes it)" || echo "$NAME wasn't running"; fi ;;
  *) echo "usage: remote.sh install | start [NAME] | attach [NAME] | status | stop [NAME|all]" >&2; exit 2 ;;
esac
