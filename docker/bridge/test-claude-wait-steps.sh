# J431 W2 (manual, real Claude Code; costs model calls): after ONE "check" and no further input, a Claude Code session handles two
# jobs approved a minute apart, by waiting with wait_for_job between them.
#   HOSTAGENTS='"bridge"' E2E_STEPS=docker/bridge/test-claude-wait-steps.sh bash docker/gateway/e2e.sh
# Nothing waits when the check starts: job 1 is approved 20 s later, job 2 a minute after job 1. The session is ended once both are
# reported (or after 8 minutes). The jobs are written as the relay writes approved jobs (the J424 test does the same).
E2E_RC=0; fail() { echo "FAIL: $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
BR="$H/docker/bridge/doorman-bridge"; export DOORMAN_STATE=$P
D=$R/x/jobdir; mkdir -p $D $P/requests; C=$R/x/claude; mkdir -p $C
cat > $C/bridge-mcp.json <<J
{ "mcpServers": { "doorman-bridge": { "command": "$BR", "args": ["mcp"], "env": { "DOORMAN_BRIDGE_AGENT": "Doorman-Host", "DOORMAN_BRIDGE_SCOPE": "world-t", "DOORMAN_STATE": "$P" } } } }
J
job() { # id word at
  local tmp=$P/requests/.$1.tmp
  echo "{\"id\":\"$1\",\"type\":\"host_job\",\"sandbox\":\"world-t\",\"for\":\"Alpha\",\"created_at\":\"$3\",\"state\":\"waiting\",\"approved\":{\"action\":\"Write the single word $2 into $D/$2.txt\",\"action_line\":\"Write the single word $2 into $D/$2.txt\",\"tools\":[\"Write\"],\"folders\":[\"$D\"],\"time_limit_s\":900},\"claim\":null,\"claimed_at\":null,\"questions\":[],\"history\":[]}" > $tmp && mv $tmp $P/requests/$1.json
}
state() { python3 -c "import json;print(json.load(open('$P/requests/$1.json'))['state'])" 2>/dev/null; }
T=mcp__doorman-bridge__
CL=(claude -p --model claude-fable-5-1 --strict-mcp-config --mcp-config $C/bridge-mcp.json --restricted --permission-mode dontAsk --add-dir $D --allowedTools "${T}list_jobs,${T}claim_job,${T}show_job,${T}renew_job,${T}ask_owner,${T}report_job,${T}release_job,${T}list_agents,${T}wait_for_job,Write" --tools Write)
cd $C
( echo "/mcp__doorman-bridge__check" | timeout 600 "${CL[@]}" > $C/out.txt 2>&1 ) & CPID=$!
sleep 20; job world-t--c43101 apple "$(date -u +%FT%TZ)"; echo "job 1 approved at $(date +%T)"
sleep 60; job world-t--c43102 pear "$(date -u +%FT%TZ)"; echo "job 2 approved at $(date +%T)"
for _ in $(seq 1 96); do [[ "$(state world-t--c43101)" == done && "$(state world-t--c43102)" == done ]] && break; kill -0 $CPID 2>/dev/null || break; sleep 5; done
echo "both reported (or gave up) at $(date +%T)"
pkill -TERM -P $CPID 2>/dev/null; kill $CPID 2>/dev/null; wait $CPID 2>/dev/null
echo "--- the session's output:"; tail -8 $C/out.txt
[ "$(tr -d '[:space:]' < $D/apple.txt 2>/dev/null)" = apple ] && ok "job 1 done (apple.txt)" || fail "apple.txt: $(cat $D/apple.txt 2>&1)"
[ "$(tr -d '[:space:]' < $D/pear.txt 2>/dev/null)" = pear ] && ok "job 2, approved a minute later, done with no further input (pear.txt)" || fail "pear.txt: $(cat $D/pear.txt 2>&1)"
for j in world-t--c43101 world-t--c43102; do s=$(state $j); [[ $s == done ]] && ok "$j reported done" || fail "$j: $s"; done
grep -q 'Doorman-Host' $P/requests/world-t--c43102.json && ok "job 2 worked by the same registered Doorman-Host" || fail "job 2 not by Doorman-Host"
