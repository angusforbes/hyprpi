# J459 steps for docker/gateway/e2e.sh: the relay sweeps the inbox at start and on its timer by the world's retention settings.
#   HYPRPI_INBOX_SWEEP_MS=2000 E2E_STEPS=docker/test-inbox-steps.sh bash docker/gateway/e2e.sh
E2E_RC=0; fail() { echo "FAIL: $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
I=$R/x/inbox; now=$(date +%s)
mk() { echo x > "$I/$1"; touch -d "@$(( now - $2 ))" "$I/$1"; }
ms() { printf '%013d-%s.json' $(( (now - $1) * 1000 )) "$2"; }
# settings: messages 1 h, reports 1 day, GPU results 2 days
python3 -c "import json;p='$XDG_CONFIG_HOME/hyprpi/worlds/world-t.json';d=json.load(open(p));d.setdefault('gateway',{}).update({'inbox_messages_hours':'1','inbox_reports_days':'1','inbox_gpu_days':'2'});json.dump(d,open(p,'w'))"
mk "$(ms 7200 aaaaaaaa)" 0; mk "$(ms 600 bbbbbbbb)" 0
mk research-old1.md $(( 2 * 86400 )); mk research-new1.md 3600
mk gpu-g0000abcd.md $(( 3 * 86400 )); mk gpu-g0000abcd-out.txt $(( 3 * 86400 )); mk gpu-g1111abcd.md 86400
mk notes.txt $(( 400 * 86400 )); mk research-x.txt $(( 400 * 86400 ))
echo "== on the timer (every 2 s here)"; sleep 4
left=$(ls $I | sort | tr '\n' ' '); echo "  left: $left"
for n in "$(ms 7200 aaaaaaaa)" research-old1.md gpu-g0000abcd.md gpu-g0000abcd-out.txt; do [ -e "$I/$n" ] && fail "still there: $n" || ok "removed on time: $n"; done
for n in "$(ms 600 bbbbbbbb)" research-new1.md gpu-g1111abcd.md notes.txt research-x.txt; do [ -e "$I/$n" ] && ok "kept: $n" || fail "removed: $n"; done
echo "== at start"
mk research-old2.md $(( 2 * 86400 ))
for p in $(pgrep -f "sbx-relay.mjs run"); do grep -q bogus-j368 /proc/$p/environ 2>/dev/null && kill $p; done; sleep 1
HYPRPI_INBOX_SWEEP_MS=3600000 setsid -f node $H/docker/sbx-relay.mjs run >> $R/x/relay.out 2>&1; sleep 3
[ -e "$I/research-old2.md" ] && fail "not swept at start" || ok "swept at relay start (timer an hour away): research-old2.md"
[ -e "$I/notes.txt" ] && ok "a file of no known kind is never touched" || fail "notes.txt removed"
grep -q '"op":"inbox_sweep"' $P/log.jsonl && ok "logged: inbox_sweep" || fail "no inbox_sweep log line"
