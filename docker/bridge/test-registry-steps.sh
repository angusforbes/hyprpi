# J407 steps for docker/gateway/e2e.sh (host-agent registration). Run:
#   HOSTAGENTS='"bridge"' E2E_STEPS=docker/bridge/test-registry-steps.sh bash docker/gateway/e2e.sh
# Isolated: the e2e harness's test daemon and relay, temp state; nothing live. Sets E2E_RC=1 on a failed check.
E2E_RC=0
fail() { echo "FAIL: $*"; E2E_RC=1; }
ok() { echo "ok $*"; }
BR="$H/docker/bridge/doorman-bridge"
export DOORMAN_STATE=$P
snap() { (cat $XDG_CONFIG_HOME/hyprpi/sbx-relay.json; ls -la $P/decisions 2>/dev/null | tail -n +2 | awk '{print $NF}'; cat $P/rules.json 2>/dev/null) | sha256sum; }
mode() { python3 -c "import json;print(json.load(open('$P/bridge/mode.json'))['sandboxes']['world-t']['mode'])" 2>/dev/null; }
card() { node $H/docker/world/shares.mjs card world-t >/dev/null 2>&1; grep -A2 '^## Host agents' $XDG_STATE_HOME/hyprpi/sandboxes/world-t/card/host-card.md 2>/dev/null | tail -1; }
held_draft() { for f in $P/pending/*.json; do [ -f $f ] && python3 -c "import json;d=json.load(open('$f'));print(d['text']) if d.get('draft') and not d.get('typed') else None"; done; }

echo "== 1 nobody registered: agent-free"
sleep 11
[ "$(mode)" = "agent-free" ] && ok "mode agent-free" || fail "mode: $(mode)"
c=$(card); case "$c" in *"none available"*) ok "card says agent-free";; *) fail "card: $c";; esac
D 1-draft '{"op":"draft","for":"Alpha","why":"needs a laptop package","action":"install foo on the laptop"}'
r=$(res $R/x/dinbox 1-draft); case "$r" in *"no host agent available"*) ok "free-form refused at once: no host agent available";; *) fail "draft: $r";; esac
[ -z "$(held_draft)" ] && ok "nothing held" || fail "a draft was held"
D 2-open '{"op":"request","type":"note_to_owner","for":"Alpha","params":{"text":"render done"}}'
r=$(res $R/x/dinbox 2-open); case "$r" in *True*) ok "fixed type still works (agent-free)";; *) fail "open: $r";; esac

echo "== 2 a claim without a registration is refused"
mkdir -p $P/requests
echo '{"id":"world-t--aaa111","type":"host_job","sandbox":"world-t","for":"Alpha","created_at":"2026-10-10T00:00:00Z","state":"waiting","approved":{"action":"say hi","action_line":"say hi","tools":[],"folders":[],"time_limit_s":600},"claim":null,"claimed_at":null,"questions":[],"outcome":null,"history":[]}' > $P/requests/world-t--aaa111.json
s0=$(snap)
r=$($BR --json claim world-t--aaa111 --by Mallory); case "$r" in *"not a registered host agent"*) ok "unregistered claim refused";; *) fail "claim: $r";; esac
r=$($BR --json claim world-t--aaa111 --agent-token deadbeef); case "$r" in *"not a registered host agent"*) ok "unknown token refused";; *) fail "claim: $r";; esac

echo "== 3 a registered host agent: available"
T=$($BR --json register TestClaude --harness claude-code --caps "edits files" | python3 -c "import json,sys;print(json.load(sys.stdin)['agent_token'])")
[ -n "$T" ] && ok "registered" || fail "no token"
sleep 2
[ "$(mode)" = "host agent available" ] && ok "mode: host agent available" || fail "mode: $(mode)"
c=$(card); case "$c" in *"available (TestClaude (claude-code))"*) ok "card names it";; *) fail "card: $c";; esac
D 3-draft '{"op":"draft","for":"Alpha","why":"needs a laptop package","action":"install foo on the laptop"}'
r=$(res $R/x/dinbox 3-draft); case "$r" in *True*) ok "free-form draft held";; *) fail "draft: $r";; esac
case "$(held_draft)" in *"Will be done by: TestClaude (claude-code)"*) ok "held item says: will be done by TestClaude (claude-code)";; *) fail "held text: $(held_draft)";; esac
D 4-open '{"op":"request","type":"note_to_owner","for":"Alpha","params":{"text":"render two done"}}'
r=$(res $R/x/dinbox 4-open); case "$r" in *True*) ok "fixed type still works (agent available)";; *) fail "open: $r";; esac
r=$($BR --json claim world-t--aaa111 --agent-token $T --by SomeoneElse)
case "$r" in *'"ok": true'*) ok "registered claim ok";; *) fail "claim: $r";; esac
by=$(python3 -c "import json;print(json.load(open('$P/requests/world-t--aaa111.json'))['claim']['by'])"); [ "$by" = "TestClaude" ] && ok "claimed in the registered name (not --by)" || fail "by: $by"
$BR --json heartbeat --agent-token $T >/dev/null && ok "heartbeat"
r=$($BR --json register TestClaude --harness x); case "$r" in *"already registered"*) ok "a live name can't be taken";; *) fail "dup: $r";; esac
s1=$(snap); [ "$s0" = "$s1" ] && ok "config, decisions and rules unchanged by register/heartbeat/claim" || fail "state changed"

echo "== 4 expiry: back to agent-free"
python3 - <<PY
import json; f='$P/bridge/agents.json'; d=json.load(open(f))
for a in d['agents'].values(): a['last']='2026-01-01T00:00:00.000Z'
json.dump(d,open(f,'w'))
PY
sleep 12
[ "$(mode)" = "agent-free" ] && ok "expired: agent-free again" || fail "mode: $(mode)"
c=$(card); case "$c" in *"none available"*) ok "card back to agent-free";; *) fail "card: $c";; esac
echo '{"id":"world-t--bbb222","type":"host_job","sandbox":"world-t","for":"Alpha","created_at":"2026-10-10T00:00:00Z","state":"waiting","approved":{"action":"x","action_line":"x","tools":[],"folders":[],"time_limit_s":600},"claim":null,"claimed_at":null,"questions":[],"outcome":null,"history":[]}' > $P/requests/world-t--bbb222.json
r=$($BR --json claim world-t--bbb222 --agent-token $T); case "$r" in *"not a registered host agent"*) ok "expired agent's claim refused";; *) fail "claim: $r";; esac
D 5-draft '{"op":"draft","for":"Alpha","why":"x","action":"install bar"}'
r=$(res $R/x/dinbox 5-draft); case "$r" in *"no host agent available"*) ok "free-form refused again";; *) fail "draft: $r";; esac
s2=$(snap); [ "$s0" = "$s2" ] && ok "config, decisions and rules still unchanged" || fail "state changed"
