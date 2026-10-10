#!/usr/bin/env bash
# J385: an isolated end-to-end run of the Doorman bridge with a REAL relay (J368's harness: test daemon and relay, temp state, fake
# sandbox and Doorman with "host_agents": "bridge", stubbed sbx/Brave). The owner's decisions are written as the relay decision files the
# guarded CLI writes (an "answer" carries his text on a note:<base64> line, as the Doorman window's "a <answer>" does).
# Prints PASS/FAIL per check; exit 1 on any FAIL. Usage: bash docker/bridge/e2e-bridge.sh
set -u
H="$(cd "$(dirname "$0")/../.." && pwd)"; R="$(mktemp -d)"; S="$H/docker/gateway"; B="$H/docker/bridge/doorman-bridge"
mkdir -p $R/x/{state,run,cfg/hyprpi/worlds,xstate,ws,dws,inbox,dinbox,card,cache}
export PATH="$S/e2e-docker-stub:$PATH" E2E_DIR=$R/x HYPRPI_TEST=1 HYPRLAND_INSTANCE_SIGNATURE=bogus-j385 HYPRPI_STATE=$R/x/state HYPRPI_SOCKET=$R/x/s.sock XDG_RUNTIME_DIR=$R/x/run
export XDG_CONFIG_HOME=$R/x/cfg XDG_STATE_HOME=$R/x/xstate DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent HYPRPI_NO_ENSURE=1 HYPRPI_G_AGENT_OPENER=$S/e2e-opener.sh HYPRPI_SBX=$S/e2e-sbx-stub.sh XDG_CACHE_HOME=$R/x/cache
cat > $R/x/cfg/hyprpi/sbx-relay.json <<J
{ "sandboxes": [ { "name": "world-t", "agent_id": "sbx-world-t", "workspace": "$R/x/ws", "inbox": "$R/x/inbox", "workspace_num": 99 },
  { "name": "doorman-t", "display": "Doorman-T", "doorman_for": "world-t", "reports_to": "Thoughts-B", "host_agents": "bridge", "workspace": "$R/x/dws", "inbox": "$R/x/dinbox", "card": "$R/x/card", "workspace_num": 98 } ] }
J
echo '{ "sandbox": "world-t", "task": "Perovskite solar cells" }' > $R/x/cfg/hyprpi/worlds/world-t.json
setsid -f node $H/bin/hyprpi daemon > $R/x/daemon.log 2>&1
for i in $(seq 1 50); do [ -S $R/x/s.sock ] && break; sleep 0.2; done
setsid -f node $H/docker/sbx-relay.mjs run > $R/x/relay.out 2>&1
sleep 3
P=$R/x/xstate/hyprpi/sbx-relay; export DOORMAN_STATE=$P; FAILS=0
ok() { if [ "$1" = 1 ]; then echo "PASS $2"; else echo "FAIL $2"; FAILS=$((FAILS+1)); fi; }
js() { python3 -c "import json,sys; d=json.load(open('$1')); print($2)" 2>/dev/null; }
decide() { printf '%s' "$3" > $P/decisions/.$1.tmp; mv $P/decisions/.$1.tmp $P/decisions/$1.$2; sleep 3; }
# 1. a free-form draft, approved, becomes a host job (not a delivery to Thoughts)
echo '{"op":"draft","for":"Alpha","why":"see the cube","tried":"nothing","action":"open ~/Work/cube-art/index.html in G'"'"'s browser"}' > $R/x/dws/.hyprpi-dropbox/outbox/1-draft.json; sleep 2
JOB=$(ls $P/pending | sed -n 's/\.json$//p' | head -1); decide $JOB approve "doorman window"
ok "$([ "$(js $P/requests/$JOB.json "d['type'],d['state']")" = "host_job waiting" ] && echo 1)" "an approved draft becomes a waiting host job ($JOB)"
# 2. a host agent claims it and asks; the relay holds the question for the owner
$B claim $JOB --by e2e-agent >/dev/null; $B ask $JOB --by e2e-agent "Which browser profile should open it?" >/dev/null; sleep 2
Q=$(js $P/requests/$JOB.json "d['questions'][0]['held_id']"); ok "$([ -f $P/pending/$Q.json ] && [ "$(js $P/pending/$Q.json "d['hostJob']['id']")" = "$JOB" ] && echo 1)" "the question is a held item ($Q) linked to the job"
ok "$([ "$($B show $JOB --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')" = asked ] && echo 1)" "the job waits (asked)"
# 3. an "answer" on an item that is NOT a question decides nothing (it stays held)
echo '{"op":"request","type":"note_to_owner","for":"Beta","params":{"text":"a note"}}' > $R/x/dws/.hyprpi-dropbox/outbox/2-note.json; sleep 2
N=$(for f in $P/pending/*.json; do js $f "d['id'] if d.get('typed') else ''"; done | grep . | head -1)
decide $N answer "doorman window
note:$(printf 'not an answer' | base64 -w0)"
ok "$([ -f $P/pending/$N.json ] && echo 1)" "an answer on a non-question item ($N) leaves it held, nothing done"
# 4. the owner's answer (what the window's "a <answer>" writes) reaches the job, bound to that held item
decide $Q answer "doorman window
note:$(printf "Use G's own profile" | base64 -w0)"
SHOW=$($B show $JOB --json)
ok "$(echo "$SHOW" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(1 if d["questions"][0]["answer"]=="Use G'"'"'s own profile" and d["state"]=="claimed" else 0)')" "show returns the answer; the job is back with its claimer"
ok "$([ ! -f $P/pending/$Q.json ] && echo 1)" "the question item is decided"
ok "$(grep -h "\"op\":\"host_job_answer\"" $P/log.jsonl | grep -q "\"id\":\"$Q\".*\"applied\":true" && echo 1)" "the relay logged the answer for that held item"
TRACK=$(cd $H && node -e "import('./lib/held.mjs').then(m=>console.log(m.trackHeld('$Q').text))")
ok "$(echo "$TRACK" | grep -q "has your answer" && echo 1)" "the window's track line: $TRACK"
# 5. the report goes back to the sandbox
$B report $JOB done --by e2e-agent --summary "Opened it in G's profile." --ran "g_open_url.py --agent file:///x" >/dev/null; sleep 2
ok "$([ "$(js $P/requests/$JOB.json "d['state']")" = done ] && grep -hq "ended done" $R/x/inbox/*.json && echo 1)" "report: the job is done and the sandbox is told"
for p in $(pgrep -f "bin/hyprpi daemon|sbx-relay.mjs run"); do grep -q bogus-j385 /proc/$p/environ 2>/dev/null && kill $p; done; sleep 1
rm -rf "$R"; echo "fails: $FAILS"; [ $FAILS = 0 ]
