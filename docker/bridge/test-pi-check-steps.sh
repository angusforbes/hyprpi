# J424 (manual, real pi): project MCP config + the skill, the prompt "check" does a job.
E2E_RC=0; fail() { echo "FAIL: $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
BR="$H/docker/bridge/doorman-bridge"; export DOORMAN_STATE=$P
D=$R/x/jobdir; mkdir -p $D $P/requests; W=$HOME/Work/.j424-pi-test; rm -rf $W; mkdir -p $W/.pi/skills
cp -r $H/docker/bridge/skill/doorman-bridge $W/.pi/skills/
cat > $W/.pi/mcp.json <<J
{ "mcpServers": { "doorman-bridge": { "command": "$BR", "args": ["mcp"], "env": { "DOORMAN_BRIDGE_AGENT": "Doorman-Host", "DOORMAN_BRIDGE_HARNESS": "pi", "DOORMAN_STATE": "$P" }, "exposure": "direct" } } }
J
echo "{\"id\":\"world-t--d4d424\",\"type\":\"host_job\",\"sandbox\":\"world-t\",\"for\":\"Alpha\",\"created_at\":\"2026-10-10T00:00:00Z\",\"state\":\"waiting\",\"approved\":{\"action\":\"Write the single word hello into $D/out.txt\",\"action_line\":\"Write the single word hello into $D/out.txt\",\"tools\":[\"Write\"],\"folders\":[\"$D\"],\"time_limit_s\":900},\"claim\":null,\"claimed_at\":null,\"questions\":[],\"history\":[]}" > $P/requests/world-t--d4d424.json
cd $W; o=$(timeout 400 pi -p --approve --no-extensions --no-context-files "check" 2>&1); echo "$o" | tail -5
[ "$(cat $D/out.txt 2>/dev/null | tr -d '[:space:]')" = hello ] && ok "pi did the job" || fail "out.txt: $(cat $D/out.txt 2>&1)"
j=$(python3 -c "import json;d=json.load(open('$P/requests/world-t--d4d424.json'));print(d['state'])"); [ "$j" = done ] && ok "reported done" || fail "state $j"
grep -q Doorman-Host $P/requests/world-t--d4d424.json && ok "as Doorman-Host (pi)" || fail "not Doorman-Host"
cd /; rm -rf $W
