# J424 steps for docker/gateway/e2e.sh: the bridge MCP server describes itself and registers itself from its env.
#   HOSTAGENTS='"bridge"' E2E_STEPS=docker/bridge/test-self-describing-steps.sh bash docker/gateway/e2e.sh
# Isolated (the e2e harness's test daemon and relay, temp state). Sets E2E_RC=1 on a failed check.
E2E_RC=0; fail() { echo "FAIL: $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
BR="$H/docker/bridge/doorman-bridge"; export DOORMAN_STATE=$P
snap() { (cat $XDG_CONFIG_HOME/hyprpi/sbx-relay.json; ls -la $P/decisions 2>/dev/null | tail -n +2 | awk '{print $NF}'; cat $P/rules.json 2>/dev/null) | sha256sum; }
start() { coproc MCP { env "$@" "$BR" mcp 2>>$R/x/mcp.err; }; n=0; }
call() { n=$((n+1)); printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$n,\"method\":\"$1\",\"params\":$2}" >&${MCP[1]}; read -r -t 60 line <&${MCP[0]}; echo "$line"; }
tool() { call tools/call "{\"name\":\"$1\",\"arguments\":$2}"; }
init() { call initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"9"}}'; }
s0=$(snap)
echo "== 1 named by env: registers itself on connect, with the client's name as harness"
start DOORMAN_BRIDGE_AGENT=Doorman-Host DOORMAN_BRIDGE_SCOPE=world-x,world-t
r=$(init); case "$r" in *'"instructions"'*"don't call register_agent"*) ok "instructions in the initialize result";; *) fail "init: $r";; esac
case "$r" in *'"prompts"'*) ok "prompts capability";; *) fail "no prompts capability";; esac
sleep 3; a=$($BR agents); case "$a" in *"Doorman-Host (claude-code)"*"world-t"*) ok "registered on connect: Doorman-Host (claude-code), for world-t";; *) fail "agents: $a";; esac
r=$(call prompts/list '{}'); case "$r" in *'"check"'*) ok "prompt check listed";; *) fail "prompts: $r";; esac
r=$(call prompts/get '{"name":"check"}'); case "$r" in *"list_jobs"*"report_job"*) ok "prompt check text";; *) fail "check: $r";; esac
r=$(call prompts/get '{"name":"other"}'); case "$r" in *error*) ok "unknown prompt: error";; *) fail "other: $r";; esac
r=$(tool register_agent '{"name":"Evil","harness":"x"}'); case "$r" in *"already registered as Doorman-Host"*) ok "register_agent can't rename it";; *) fail "reg: $r";; esac
echo '{"id":"world-t--aaa424","type":"host_job","sandbox":"world-t","for":"Alpha","created_at":"2026-10-10T00:00:00Z","state":"waiting","approved":{"action":"say hi","action_line":"say hi","tools":[],"folders":[],"time_limit_s":600},"claim":null,"claimed_at":null,"questions":[],"history":[]}' > $P/requests/world-t--aaa424.json 2>/dev/null || { mkdir -p $P/requests; echo '{"id":"world-t--aaa424","type":"host_job","sandbox":"world-t","for":"Alpha","created_at":"2026-10-10T00:00:00Z","state":"waiting","approved":{"action":"say hi","action_line":"say hi","tools":[],"folders":[],"time_limit_s":600},"claim":null,"claimed_at":null,"questions":[],"history":[]}' > $P/requests/world-t--aaa424.json; }
r=$(tool claim_job '{"id":"world-t--aaa424"}'); case "$r" in *'\"ok\": true'*|*'"ok": true'*) ok "claim without calling register_agent";; *) fail "claim: $r";; esac
by=$(python3 -c "import json;print(json.load(open('$P/requests/world-t--aaa424.json'))['claim']['by'])" 2>/dev/null); [ "$by" = Doorman-Host ] && ok "claimed as Doorman-Host" || fail "by: $by"
r=$(tool report_job '{"id":"world-t--aaa424","state":"done","summary":"test"}'); case "$r" in *'ok'*) ok "report";; *) fail "report: $r";; esac
sleep 35; a=$($BR agents); case "$a" in *Doorman-Host*) ok "still registered after 35 s (heartbeat)";; *) fail "expired: $a";; esac
exec {MCP[1]}>&-; sleep 3; a=$($BR agents); case "$a" in *Doorman-Host*) fail "still there after close: $a";; *) ok "unregistered on close";; esac
echo "== 2 no env: nothing automatic, the instructions say to register"
start DOORMAN_BRIDGE_HARNESS=x
r=$(init); case "$r" in *"call register_agent once"*) ok "instructions: register yourself";; *) fail "init: $r";; esac
sleep 3; a=$($BR agents); case "$a" in *"(x"*|*"mcp agent"*) fail "registered without a name: $a";; *) ok "no automatic registration";; esac
exec {MCP[1]}>&-; sleep 1
echo "== 3 a hostile harness/scope env is cleaned; a per-job run (DOORMAN_BRIDGE_JOB) gets no instructions, prompts or registration"
start 'DOORMAN_BRIDGE_AGENT=Doorman-Host2' 'DOORMAN_BRIDGE_HARNESS=[x](http://e)<b>' 'DOORMAN_BRIDGE_CAPS=a`b'
init >/dev/null; sleep 3; a=$($BR agents); case "$a" in *"Doorman-Host2 (xhttpeb)"*) ok "harness cleaned: $(echo "$a" | grep -o 'Doorman-Host2 ([^)]*)')";; *) fail "agents: $a";; esac
exec {MCP[1]}>&-; sleep 3
start DOORMAN_BRIDGE_AGENT=Runner1 DOORMAN_BRIDGE_JOB=world-t--aaa424
r=$(init); case "$r" in *instructions*|*prompts*) fail "job run: $r";; *) ok "per-job run: no instructions or prompts";; esac
sleep 3; a=$($BR agents); case "$a" in *Runner1*) fail "job run registered itself";; *) ok "per-job run: no self-registration (the runner registers)";; esac
exec {MCP[1]}>&-; sleep 1
s1=$(snap); [ "$s0" = "$s1" ] && ok "config, decisions and rules byte-identical" || fail "state changed"
