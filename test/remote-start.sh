#!/usr/bin/env bash
# J543: omnistation/remote.sh start with the daemon's HYPRPI_START_* (open_agent / spawn_agent on a remote world's machine), against a
# stand-in tmux (records the command, no real sessions) in a temp HOME. Checks: the agent runs `hyprpi new` with its display name,
# icon, folder, model, thinking and workspace; its RPC socket goes by the slug (HYPRPI_RPC_NAME); bad values fall back to the
# defaults; a new agent whose slug is taken is refused; pi-entry serves HYPRPI_RPC_NAME before HYPRPI_NAME.
#   bash test/remote-start.sh   (exit 0 = pass)
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.cache"; T=$(mktemp -d "$HOME/.cache/j543-start-XXXXXX") # (remote.sh refuses a world-writable /tmp on the way); trap '[[ -n "${KEEP:-}" ]] || rm -rf "$T"' EXIT
fails=0; ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
H="$T/home"; mkdir -p "$H/.hyprpi-h/run" "$H/bin" "$H/work" "$H/proj"; chmod 700 "$H" "$H/.hyprpi-h"
cp "$R/omnistation/remote.sh" "$H/.hyprpi-h/remote.sh"
cat > "$H/bin/tmux" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/tmux.log"
case "\$1" in
  has-session) t="\${3#=}"; [[ "\$t" == hyprpi-h-daemon || -e "$T/s-\$t" ]] ;;
  new-session) for ((i=1; i<=\$#; i++)); do [[ "\${!i}" == -s ]] && { j=\$((i+1)); touch "$T/s-\${!j}"; }; done; printf '%s\n' "\${@: -1}" > "$T/cmd-last" ;;
  *) exit 0 ;;
esac
EOF
chmod 755 "$H/bin/tmux"
python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$H/.hyprpi-h/run/daemon.sock"
run() { env -i HOME="$H" PATH="$H/bin:/usr/bin:/bin" HYPRPI_DIR="$R" HYPRPI_REMOTE_WS=71 HYPRPI_REMOTE_WORK="$H/work" "$@" bash "$H/.hyprpi-h/remote.sh" start "$SLUG" 2>"$T/err"; }
SLUG=farside; run HYPRPI_START_NEW=1 HYPRPI_START_DISPLAY=Farside HYPRPI_START_ICON=🔭 HYPRPI_START_CWD="$H/proj" HYPRPI_START_MODEL=anthropic/claude-opus-5-5 HYPRPI_START_THINKING=high HYPRPI_START_WS=74 >/dev/null; rc=$?
C=$(cat "$T/cmd-last" 2>/dev/null); [[ -n "${KEEP:-}" ]] && echo "$C" >&2
ok "starts (rc $rc: $(head -c 200 "$T/err"))" '[[ $rc == 0 ]]'
ok "id h-farside, display name Farside, icon, folder" '[[ "$C" == *"new --id h-farside --name Farside --icon "@(🔭|\$\'"'"'\\360\\237\\224\\255\'"'"')" --cwd $H/proj "* ]]'
ok "workspace 74, model and thinking passed to pi" '[[ "$C" == *"--workspace 74 -- --model anthropic/claude-opus-5-5 --thinking high --session-dir "* ]]'
ok "its socket goes by the slug (HYPRPI_RPC_NAME=farside), RPC mode" '[[ "$C" == *"HYPRPI_RPC_NAME=\"farside\""* || "$C" == *"HYPRPI_RPC_NAME=farside"* ]] && [[ "$C" == *HYPRPI_REMOTE_RPC* ]]'
ok "tmux session hyprpi-h-farside in the folder" 'grep -q -- "new-session -d -s hyprpi-h-farside -c $H/proj" "$T/tmux.log"'
SLUG=farside; run HYPRPI_START_NEW=1 HYPRPI_START_DISPLAY=Farside >/dev/null; rc=$?
ok "a NEW agent whose slug is taken is refused" '[[ $rc == 3 ]] && grep -q taken "$T/err"'
SLUG=bad; run HYPRPI_START_NEW=1 HYPRPI_START_DISPLAY='x"; rm -rf ~;' HYPRPI_START_ICON='a$(id)' HYPRPI_START_CWD=/nonexistent HYPRPI_START_MODEL='m; id' HYPRPI_START_THINKING=huge HYPRPI_START_WS=5 >/dev/null; rc=$?
C=$(cat "$T/cmd-last")
ok "bad values fall back to the defaults (name = slug, its own icon, ~/work, ws 71, no pi flags)" '[[ $rc == 0 && "$C" == *"--name bad --icon "* && "$C" != *"a\$(id)"* && "$C" == *"--cwd $H/work --workspace 71 -- --session-dir "* ]]'
SLUG=plain; run >/dev/null; C=$(cat "$T/cmd-last")
ok "a plain start (world X new / SUPER+A) is as before" '[[ "$C" == *"new --id h-plain --name plain --icon "* && "$C" == *"--workspace 71 -- --session-dir "* ]]'
# J543: a restart by the daemon (upkeep refresh / restart): waits for the old tmux session to end, then fresh or on the named session
mkdir -p "$H/.hyprpi-h/sessions/plain"; touch "$H/.hyprpi-h/sessions/plain/old.jsonl"; sleep 1; touch "$H/.hyprpi-h/sessions/plain/new.jsonl"
SLUG=plain; ( sleep 2; rm -f "$T/s-hyprpi-h-plain" ) & run HYPRPI_START_RESTART=1 HYPRPI_START_FRESH=1 >/dev/null; C=$(cat "$T/cmd-last")
ok "restart, fresh: waits for the old session to end, then starts with no --session" '[[ "$C" == *"new --id h-plain"* && "$C" != *"--session "* ]]'
rm -f "$T/s-hyprpi-h-plain"; run HYPRPI_START_RESTART=1 HYPRPI_START_SESSION="$H/.hyprpi-h/sessions/plain/old.jsonl" >/dev/null; C=$(cat "$T/cmd-last")
ok "restart on a named session of its own (not the newest)" '[[ "$C" == *"--session $H/.hyprpi-h/sessions/plain/old.jsonl"* ]]'
rm -f "$T/s-hyprpi-h-plain"; touch "$T/elsewhere.jsonl"; run HYPRPI_START_RESTART=1 HYPRPI_START_SESSION="$T/elsewhere.jsonl" >/dev/null; C=$(cat "$T/cmd-last")
ok "a session outside its own folder is ignored (its newest is resumed)" '[[ "$C" == *"--session $H/.hyprpi-h/sessions/plain/new.jsonl"* ]]'
# pi-entry (written by install): built here from install's own printf line, then run with a stand-in node/pi
line=$(grep -m1 "^    printf '#!/usr/bin/env bash" "$R/omnistation/remote.sh")
( ROOT="$T/pe"; mkdir -p "$ROOT"; eval "${line%%; chmod*}" ) && chmod 755 "$T/pe/pi-entry"
printf '#!/bin/sh\necho "node $*"\n' > "$T/pe/node"; printf '#!/bin/sh\necho "pi $*"\n' > "$T/pe/pi"; chmod 755 "$T/pe/node" "$T/pe/pi"
pe() { env -i PATH="$T/pe:/usr/bin:/bin" "$@"; }
ok "pi-entry: the agent's own pi (HYPRPI_RPC_NAME) is served by hbroker under its slug" '[[ "$(pe HYPRPI_REMOTE_RPC=1 HYPRPI_RPC_NAME=farside HYPRPI_NAME=Farside "$T/pe/pi-entry" -e x --session-dir d)" == "node "*"hbroker.mjs serve farside -- -e x --session-dir d" ]]'
ok "pi-entry: an older agent (HYPRPI_NAME only) still is" '[[ "$(pe HYPRPI_REMOTE_RPC=1 HYPRPI_NAME=omni-alpha "$T/pe/pi-entry" -e x)" == *"serve omni-alpha -- -e x" ]]'
ok "pi-entry: a one-shot pi -p with an agent's env (the daemon's topic labels) is plain pi" '[[ "$(pe HYPRPI_REMOTE_RPC=1 HYPRPI_NAME=omni-alpha "$T/pe/pi-entry" -p --no-session hi)" == "pi -p --no-session hi" ]]'
ok "pi-entry: --mode rpc (Thoughts) is plain pi; a display name that isn't a slug is never served" '[[ "$(pe HYPRPI_REMOTE_RPC=1 HYPRPI_RPC_NAME=farside "$T/pe/pi-entry" --mode rpc)" == "pi --mode rpc" && "$(pe HYPRPI_REMOTE_RPC=1 HYPRPI_NAME=Farside "$T/pe/pi-entry" -e x)" == "pi -e x" ]]'
# bonk / ding (written by install): mark the agent blocked through hyprpi, quietly, with the message
bl=$(grep -m1 -F '# bonk on this machine (omnistation/remote.sh, J543)' "$R/omnistation/remote.sh"); dl=$(grep -m1 -F '/bonk" --ding "$@"' "$R/omnistation/remote.sh")
( ROOT="$T/pe"; DIR="$T/pe/hp"; mkdir -p "$ROOT/bin"; eval "${bl}"; eval "${dl%%; chmod*}"; chmod 755 "$ROOT/bin/bonk" "$ROOT/bin/ding" )
printf '#!/bin/sh\necho "timeout $*"\n' > "$T/pe/timeout"; chmod 755 "$T/pe/timeout"
ok "bonk: a hyprpi agent's bonk marks it blocked quietly with its message" '[[ "$(pe HYPRPI_AGENT_ID=h-x "$T/pe/bin/bonk" look at this)" == "timeout 5 node $T/pe/hp/bin/hyprpi status blocked --quiet --note look at this" ]]'
ok "ding: the question becomes a decision" '[[ "$(pe HYPRPI_AGENT_ID=h-x "$T/pe/bin/ding" ship it?)" == *"status blocked --quiet --decision ship it?" ]]'
(( fails )) && { echo "FAIL ($fails)"; exit 1; }; echo PASS
