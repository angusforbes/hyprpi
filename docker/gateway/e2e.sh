#!/usr/bin/env bash
# J368: an isolated end-to-end run of the agent-free gateway: a test daemon and relay (temp state, HYPRPI_TEST), a fake sandbox and
# Doorman, stubbed Brave and sbx. Decisions are made by writing the relay decision files (as the guarded CLI does). Prints what
# happened at each step. Usage: bash docker/gateway/e2e.sh   (HOSTAGENTS=false for the agent-free refusals)
set -u
H="$(cd "$(dirname "$0")/../.." && pwd)"; R="$(mktemp -d)"; S="$(cd "$(dirname "$0")" && pwd)"
rm -rf $R/x; mkdir -p $R/x/{state,run,cfg/hyprpi/worlds,xstate,ws,dws,inbox,dinbox,card,Work/proj}
export PATH="$S/e2e-docker-stub:$PATH" E2E_DIR=$R/x HYPRPI_TEST=1 HYPRLAND_INSTANCE_SIGNATURE=bogus-j368 HYPRPI_STATE=$R/x/state HYPRPI_SOCKET=$R/x/s.sock XDG_RUNTIME_DIR=$R/x/run
export XDG_CONFIG_HOME=$R/x/cfg XDG_STATE_HOME=$R/x/xstate DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent HYPRPI_NO_ENSURE=1 HYPRPI_G_AGENT_OPENER=$S/e2e-opener.sh HYPRPI_SBX=$S/e2e-sbx-stub.sh
HA=${HOSTAGENTS:-true}
cat > $R/x/cfg/hyprpi/sbx-relay.json <<J
{ "sandboxes": [ { "name": "world-t", "agent_id": "sbx-world-t", "workspace": "$R/x/ws", "inbox": "$R/x/inbox", "workspace_num": 99 },
  { "name": "doorman-t", "display": "Doorman-T", "doorman_for": "world-t", "reports_to": "Thoughts-B", "host_agents": $HA, "workspace": "$R/x/dws", "inbox": "$R/x/dinbox", "card": "$R/x/card", "workspace_num": 98 } ] }
J
echo '{ "projectFolders": ["'$R'/x/Work"] }' > $R/x/cfg/hyprpi/config.json
echo '{ "sandbox": "world-t", "task": "Perovskite solar cells" }' > $R/x/cfg/hyprpi/worlds/world-t.json
echo 'hello' > $R/x/Work/proj/notes.md
setsid -f node $H/bin/hyprpi daemon > $R/x/daemon.log 2>&1
for i in $(seq 1 50); do [ -S $R/x/s.sock ] && break; sleep 0.2; done
setsid -f node $H/docker/sbx-relay.mjs run > $R/x/relay.out 2>&1
sleep 3
P=$R/x/xstate/hyprpi/sbx-relay
D() { echo "$2" > $R/x/dws/.hyprpi-dropbox/outbox/$1.json; sleep 2; }
W() { echo "$2" > $R/x/ws/.hyprpi-dropbox/outbox/$1.json; sleep 2; }
res() { python3 -c "
import json,glob
for f in sorted(glob.glob('$1/*.json')):
  d=json.load(open(f))
  if d.get('type')=='result' and d.get('for')=='$2.json': print('  result:', d.get('ok'), d.get('error') or '')"; }
pend() { for f in $P/pending/*.json; do [ -f $f ] && python3 -c "import json;d=json.load(open('$f'));print(d['id'], (d.get('typed') or {}).get('type'), (d.get('taskChange') or {}).get('for'))"; done; }
decide() { touch $P/decisions/$1.$2; sleep 4; }
. "$S/e2e-steps.sh"
for p in $(pgrep -f "bin/hyprpi daemon|sbx-relay.mjs run"); do grep -q bogus-j368 /proc/$p/environ 2>/dev/null && kill $p; done; sleep 1
rm -rf "$R"
