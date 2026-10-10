# J424 W1 (manual, real Claude Code; costs a few model calls): only the MCP config, no first prompt; the 'check' prompt does a job.
#   HOSTAGENTS='"bridge"' E2E_STEPS=docker/bridge/test-claude-check-steps.sh bash docker/gateway/e2e.sh
E2E_RC=0; fail() { echo "FAIL: $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
BR="$H/docker/bridge/doorman-bridge"; export DOORMAN_STATE=$P
D=$R/x/jobdir; mkdir -p $D $P/requests; C=$R/x/claude; mkdir -p $C
cat > $C/bridge-mcp.json <<J
{ "mcpServers": { "doorman-bridge": { "command": "$BR", "args": ["mcp"], "env": { "DOORMAN_BRIDGE_AGENT": "Doorman-Host", "DOORMAN_STATE": "$P" } } } }
J
echo "{\"id\":\"world-t--c4c424\",\"type\":\"host_job\",\"sandbox\":\"world-t\",\"for\":\"Alpha\",\"created_at\":\"2026-10-10T00:00:00Z\",\"state\":\"waiting\",\"approved\":{\"action\":\"Write the single word hello into $D/out.txt\",\"action_line\":\"Write the single word hello into $D/out.txt\",\"tools\":[\"Write\"],\"folders\":[\"$D\"],\"time_limit_s\":900},\"claim\":null,\"claimed_at\":null,\"questions\":[],\"history\":[]}" > $P/requests/world-t--c4c424.json
CL=(claude -p --model claude-fable-5-1 --strict-mcp-config --mcp-config $C/bridge-mcp.json --restricted --permission-mode dontAsk --add-dir $D --allowedTools "mcp__doorman-bridge__list_jobs,mcp__doorman-bridge__claim_job,mcp__doorman-bridge__show_job,mcp__doorman-bridge__renew_job,mcp__doorman-bridge__ask_owner,mcp__doorman-bridge__report_job,mcp__doorman-bridge__release_job,mcp__doorman-bridge__list_agents,Write" --tools Write)
cd $C
o1=$(echo "Without calling any tool: quote, word for word, the first line of the instructions the doorman-bridge MCP server gave you, and say whether you are already registered." | timeout 240 "${CL[@]}" 2>&1); echo "--- instructions run:"; echo "$o1" | tail -4
case "$o1" in *"host agent for the Doorman bridge"*) ok "the server's instructions are in Claude's context";; *) fail "instructions not seen";; esac
o2=$(echo "/mcp__doorman-bridge__check" | timeout 400 "${CL[@]}" 2>&1); echo "--- check run:"; echo "$o2" | tail -6
[ "$(cat $D/out.txt 2>/dev/null | tr -d '[:space:]')" = hello ] && ok "the job was done (out.txt = hello)" || fail "out.txt: $(cat $D/out.txt 2>&1)"
j=$(python3 -c "import json;d=json.load(open('$P/requests/world-t--c4c424.json'));print(d['state'],d.get('claim') and d['claim'].get('by'),[h.get('by') for h in d.get('history',[])][-3:])"); echo "job: $j"
case "$j" in done*) ok "reported done";; *) fail "job: $j";; esac
grep -q '"by":"Doorman-Host"\|Doorman-Host' $P/requests/world-t--c4c424.json && ok "worked as Doorman-Host (registered on connect, no register call asked for)" || fail "not by Doorman-Host"
sleep 3; a=$($BR agents); case "$a" in *Doorman-Host*) fail "still registered after claude exited: $a";; *) ok "unregistered when claude exited";; esac
