#!/usr/bin/env bash
# remote.sh: hyprpi headless on a remote Linux machine (J469, world H: "agents running on a remote server, seen here").
# Runs ON the remote machine. The laptop sends it over ssh (omnistation/world-h), so nothing has to be installed there first:
#   ssh HOST "mkdir -p ~/.hyprpi-x && cat > ~/.hyprpi-x/remote.sh" < omnistation/remote.sh; ssh HOST bash ~/.hyprpi-x/remote.sh install
# One folder per laptop world bound to this machine: ~/.hyprpi-<letter> (its daemon, agents, sessions); the folder this script
# sits in names the world, so two worlds can share a machine. HYPRPI_REMOTE_WS (sent by the laptop) is that world's first
# workspace; it is remembered in <folder>/ws.
#
#   remote.sh install            clone (or update) hyprpi into ~/hyprpi from its public repo; check node 22+ and pi (install pi
#                                into ~/.local with npm if it's missing, the version hyprpi is tested with)
#   remote.sh start [NAME]       start the headless daemon and one agent NAME (default alpha) in tmux; both outlive ssh. Its room is
#                                its world's (HYPRPI_REMOTE_WS): the laptop shows it on that world's workspaces
#                                The agent's pi runs in RPC mode behind omnistation/hbroker.mjs (J471): a laptop window draws pi's
#                                interface locally and sends only finished messages. HYPRPI_REMOTE_MIRROR=1 starts it the old way
#                                (pi's own terminal UI in tmux, for `attach`)
#   remote.sh connect NAME [nostart]  pipe this ssh's stdin/stdout to agent NAME's RPC socket (what a laptop window runs)
#   remote.sh attach [NAME]      attach this terminal to a mirror-mode agent's tmux (the old window); detach = close the window
#   remote.sh status             daemon and agents, as hyprpi sees them
#   remote.sh stop [NAME|all]    stop an agent (its session file stays, so `start NAME` resumes it), or everything
#
# Headless: no Hyprland, no panels, no windows. The daemon and each agent run in their own tmux session (hyprpi-<letter>-*), so an ssh
# disconnect (or the laptop sleeping) leaves them running; `attach` reconnects to the same pi and session. State lives in
# ~/.hyprpi-<letter> (daemon socket, registry), separate from any desktop hyprpi on that machine. Nothing here names a particular site.
set -euo pipefail
REPO_URL="${HYPRPI_REPO_URL:-https://github.com/angusforbes/hyprpi.git}"
DIR="${HYPRPI_DIR:-$HOME/hyprpi}"
ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
W="${ROOT##*/.hyprpi-}"
[[ "$ROOT" == "$HOME/.hyprpi-$W" && "$W" =~ ^[a-i]$ ]] || { echo "remote.sh: run me as ~/.hyprpi-<world letter>/remote.sh (I'm in $ROOT)" >&2; exit 2; }
[[ -n "${HYPRPI_REMOTE_WS:-}" ]] || HYPRPI_REMOTE_WS=$(cat "$ROOT/ws" 2>/dev/null || true)
WORK="${HYPRPI_REMOTE_WORK:-$HOME/work}"
export HYPRPI_STATE="$ROOT/state" HYPRPI_SOCKET="$ROOT/run/daemon.sock" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$ROOT/run}" HYPRPI_NO_ADOPT=1
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
unset HYPRLAND_INSTANCE_SIGNATURE WAYLAND_DISPLAY DISPLAY  # headless: never a desktop, even if one is around
# the laptop's terminal type may be unknown here (kitty's xterm-kitty): tmux needs one it knows
infocmp "${TERM:-dumb}" >/dev/null 2>&1 || export TERM=xterm-256color
# a machine whose outbound TLS is inspected by its own CA: node (pi, hyprpi) must trust the system bundle, as curl does
[[ -z "${NODE_EXTRA_CA_CERTS:-}" && -r /etc/ssl/certs/ca-certificates.crt ]] && export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
cmd="${1:-status}"; NAME="${2:-alpha}"
[[ "${HYPRPI_REMOTE_WS:-}" =~ ^[0-9]{1,3}$ ]] || { echo "remote.sh: HYPRPI_REMOTE_WS (the world's first workspace) isn't set" >&2; exit 2; }
[[ "$(cat "$ROOT/ws" 2>/dev/null)" == "$HYPRPI_REMOTE_WS" ]] || echo "$HYPRPI_REMOTE_WS" > "$ROOT/ws"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{0,30}$ || "$NAME" == all ]] || { echo "remote.sh: a name is lowercase letters, digits and -" >&2; exit 2; }
mkdir -p "$ROOT/state" "$ROOT/run" "$WORK"; chmod 700 "$ROOT" "$ROOT/run"
hp() { node "$DIR/bin/hyprpi" "$@"; }
# Secrets must be private (Ledger, J469/J471): files 600 or tighter, their folders 700, else nothing starts
secrets_ok() {
  local bad=() f d
  for f in "$HOME/.config/hyprpi-secrets"/* "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/models.json" "$HOME/.ai-pim-utils/tokens.toml"; do
    [[ -e "$f" ]] || continue
    [[ $(( 8#$(stat -c %a "$f") & 077 )) -eq 0 ]] || bad+=("chmod 600 $(printf %q "$f")")
  done
  for d in "$HOME/.config/hyprpi-secrets" "$HOME/.ai-pim-utils" "$HOME/.pi/agent"; do
    [[ -d "$d" ]] || continue
    [[ $(( 8#$(stat -c %a "$d") & 077 )) -eq 0 ]] || bad+=("chmod 700 $(printf %q "$d")")
  done
  (( ${#bad[@]} == 0 )) && return 0
  echo "remote.sh: refusing to start: a secret is readable by others. Fix with:" >&2; printf '  %s\n' "${bad[@]}" >&2; return 1
}
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
    # J471: hyprpi starts agents through pi-entry, which runs pi in RPC mode behind hbroker for an agent started by `start`
    # (HYPRPI_REMOTE_RPC=1) and is plain pi for everything else (the daemon's own pi calls)
    [[ -f "$ROOT/hbroker.mjs" ]] || { echo "remote.sh: $ROOT/hbroker.mjs is missing (world-h setup copies it)" >&2; exit 3; }
    printf '#!/usr/bin/env bash\n# hyprpi'"'"'s pi command on this machine (omnistation/remote.sh, J471)\nif [[ "${HYPRPI_REMOTE_RPC:-}" == 1 && -n "${HYPRPI_NAME:-}" ]]; then exec node %q serve "$HYPRPI_NAME" -- "$@"; fi\nexec pi "$@"\n' "$ROOT/hbroker.mjs" > "$ROOT/pi-entry"; chmod 755 "$ROOT/pi-entry"
    node -e 'const fs=require("fs"),[c,e]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(c,"utf8"));j.pi=e;fs.writeFileSync(c,JSON.stringify(j,null,2)+"\n")' "$c" "$ROOT/pi-entry"
    echo "hyprpi $(git -C "$DIR" log -1 --format=%h 2>/dev/null || cat "$DIR/.version" 2>/dev/null) in $DIR; pi $(pi --version 2>/dev/null | head -1); node $(node -v)"
    echo "next: log pi in once (run \`pi\` here, /login), then: remote.sh start" ;;
  start)
    secrets_ok || exit 5
    tmux has-session -t hyprpi-$W-daemon 2>/dev/null || tmux new-session -d -s hyprpi-$W-daemon "$(declare -p HYPRPI_STATE HYPRPI_SOCKET XDG_RUNTIME_DIR HYPRPI_NO_ADOPT PATH ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS} | sed 's/^declare -x /export /'); exec node $(printf %q "$DIR/bin/hyprpi") daemon"
    for _ in $(seq 30); do [[ -S "$HYPRPI_SOCKET" ]] && break; sleep 0.5; done
    [[ -S "$HYPRPI_SOCKET" ]] || { echo "remote.sh: the daemon didn't start (tmux attach -t hyprpi-$W-daemon shows why)" >&2; exit 4; }
    if tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null; then echo "agent $NAME already runs"; exit 0; fi
    # its pi session is resumed when it ran before (the newest session of this agent id), else a new one starts
    sess=$(ls -t "$ROOT/sessions/$NAME"/*.jsonl 2>/dev/null | head -1 || true)
    if [[ "${HYPRPI_REMOTE_MIRROR:-}" == 1 ]]; then export HYPRPI_REMOTE_RPC=0; else export HYPRPI_REMOTE_RPC=1; fi
    tmux new-session -d -s "hyprpi-$W-$NAME" -c "$WORK" "$(declare -p HYPRPI_STATE HYPRPI_SOCKET XDG_RUNTIME_DIR HYPRPI_NO_ADOPT HYPRPI_REMOTE_RPC PATH ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS} | sed 's/^declare -x /export /'); exec node $(printf %q "$DIR/bin/hyprpi") new --id $W-$NAME --name $NAME --cwd $(printf %q "$WORK") --workspace $(printf %q "$HYPRPI_REMOTE_WS") -- --session-dir $(printf %q "$ROOT/sessions/$NAME") ${sess:+--session $(printf %q "$sess")}"  # (Ledger: every path quoted for the tmux command string)
    tmux set-option -t "hyprpi-$W-$NAME" status off >/dev/null 2>&1 || true  # the window looks like any hyprpi agent: no tmux bar
    sleep 2; tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null && echo "agent $NAME started (tmux session hyprpi-$W-$NAME)" || { echo "remote.sh: agent $NAME exited at once" >&2; exit 4; } ;;
  connect)
    # (no output of our own on stdout: it carries the RPC stream)
    # a window's reconnect passes "nostart": an agent stopped on purpose stays stopped
    [[ "${3:-}" == nostart ]] || tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null || bash "$ROOT/remote.sh" start "$NAME" >/dev/null 2>&1 || true
    for _ in $(seq 20); do [[ -S "$ROOT/run/$NAME.rpc.sock" ]] && break; sleep 0.5; done
    exec node "$ROOT/hbroker.mjs" connect "$NAME" ;;
  attach)
    tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null || bash "$ROOT/remote.sh" start "$NAME" >/dev/null
    tmux set-option -t "hyprpi-$W-$NAME" status off >/dev/null 2>&1 || true
    exec tmux attach -t "hyprpi-$W-$NAME" ;;
  status)
    tmux ls 2>/dev/null | grep "^hyprpi-$W-" || echo "nothing running"
    [[ -S "$HYPRPI_SOCKET" ]] && hp list 2>/dev/null | head -20 || true ;;
  stop)
    if [[ "$NAME" == all ]]; then for s in $(tmux ls -F '#S' 2>/dev/null | grep "^hyprpi-$W-"); do tmux kill-session -t "$s"; done; echo "stopped all"
    else tmux kill-session -t "hyprpi-$W-$NAME" 2>/dev/null && echo "stopped $NAME (its session stays: start $NAME resumes it)" || echo "$NAME wasn't running"; fi ;;
  *) echo "usage: remote.sh install | start [NAME] | connect [NAME] | attach [NAME] | status | stop [NAME|all]" >&2; exit 2 ;;
esac
