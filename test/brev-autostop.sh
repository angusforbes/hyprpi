#!/usr/bin/env bash
# Stub tests for brev/autostop/brev-autostop (J498). No real brev, ssh, box, notification or Thoughts line:
#  - brev: a stub that reads its status from $F/status ("RUNNING", "STOPPED", "absent", "error") and logs `stop` calls;
#  - ssh: a stub that runs the script's real probe locally with HOME=$F/home (fixture files with chosen ages) and a stub curl
#    that serves $F/metrics (vLLM's /metrics), so the box-side probe code is exercised too;
#  - notify-send and hyprpi: stubs that log.
# Time is the laptop's real clock; fixture files get mtimes N minutes in the past (touch -d), and the script's own
# "first seen RUNNING" time is moved back by editing its state file.
# Run: bash test/brev-autostop.sh   (exit 0 = all pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; S="$HERE/brev/autostop/brev-autostop"
F="$(mktemp -d)"; trap 'rm -rf "$F"' EXIT
mkdir -p "$F/bin" "$F/state"
cat > "$F/bin/brev" <<'EOF'
#!/usr/bin/env bash
F="$(dirname "$0")/.."
case "$1" in
  ls) st="$(cat "$F/status")"; [[ "$st" == error ]] && { echo "api error" >&2; exit 1; }
      echo "NAME STATUS"; [[ "$st" != absent ]] && echo "hyprpi-l40s $st"; echo "nemoclaw-8917fb STOPPED"; exit 0;;
  stop) echo "stop $2" >> "$F/calls"; echo "stop $2" >> "$F/allcalls"; [[ -f "$F/stophang" ]] && { trap "" TERM; sleep 30; }; [[ -f "$F/stopfail" ]] && { echo "boom" >&2; exit 1; }; echo STOPPED > "$F/status"; exit 0;;
esac
EOF
cat > "$F/bin/ssh" <<'EOF'
#!/usr/bin/env bash
F="$(cd "$(dirname "$0")/.." && pwd)"
echo "ssh $*" >> "$F/sshcalls"
[[ -f "$F/sshfail" ]] && exit 255
[[ -f "$F/sshhold" ]] && { touch "$F/sshheld"; while [[ -f "$F/sshhold" ]]; do sleep 0.1; done; }
HOME="$F/home" PATH="$F/bin:$PATH" bash -s
EOF
cat > "$F/bin/curl" <<'EOF'
#!/usr/bin/env bash
F="$(dirname "$0")/.."; [[ -f "$F/metrics" ]] && cat "$F/metrics" || exit 7
EOF
printf '#!/usr/bin/env bash\necho "notify $*" >> "%s/calls"\n' "$F" > "$F/bin/notify-send"
printf '#!/usr/bin/env bash\necho "hyprpi $*" >> "%s/calls"\n' "$F" > "$F/bin/hyprpi"
chmod +x "$F/bin/"*
export BREV_AUTOSTOP_STATE="$F/state" BREV_AUTOSTOP_BREV="$F/bin/brev" BREV_AUTOSTOP_SSH="$F/bin/ssh" BREV_AUTOSTOP_NOTIFY="$F/bin/notify-send" BREV_AUTOSTOP_HYPRPI="$F/bin/hyprpi"
H="$F/home"
fixture() { # every activity file N minutes old
  rm -rf "$H"; mkdir -p "$H/.hyprpi-i/sessions/s1" "$H/.hyprpi-i/state/thoughts" "$H/.hyprpi-i/state/boards" "$H/workspace/outputs" "$H/workspace/shared"
  for f in "$H/.hyprpi-i/sessions/s1/a.jsonl" "$H/.hyprpi-i/state/thoughts/I.thread.jsonl" "$H/.hyprpi-i/state/boards/I.jsonl" "$H/workspace/outputs/x.png" "$H/workspace/shared/n.txt"; do echo x > "$f"; touch -d "-$1 min" "$f"; done
}
fresh() { rm -rf "$F/state"/* "$F/calls" "$F/sshcalls" "$F/stopfail" "$F/sshfail" "$F/metrics" "$F/stophang" "$F/sshhold" "$F/sshheld"; }
started_ago() { echo $(( $(date +%s) - $1 * 60 )) > "$F/state/running_since"; } # pretend the timer first saw it RUNNING N min ago
run() { "$S" run; }
pass=0; fail=0
ok() { if eval "$2"; then echo "ok   $1"; pass=$((pass+1)); else echo "FAIL $1"; echo "     calls: $(tr '\n' '|' < "$F/calls" 2>/dev/null || true)"; echo "     log: $(tail -3 "$F/state/log" 2>/dev/null | tr '\n' '|')"; fail=$((fail+1)); fi; }
cnt() { [[ -f "$F/calls" ]] || { echo 0; return; }; grep -c "$1" "$F/calls"; }
stops() { cnt '^stop '; }
notices() { cnt '^notify '; }
thoughts() { cnt '^hyprpi thoughts alert A '; }

# 1. RUNNING, everything idle 50 min, box seen RUNNING for 50 min: stopped, one notice each
fresh; fixture 50; echo RUNNING > "$F/status"; run; started_ago 50; run
ok "RUNNING + idle 50 min → brev stop hyprpi-l40s" '[[ $(stops) == 1 ]] && grep -qx "stop hyprpi-l40s" "$F/calls"'
ok "one desktop notice + one Thoughts-A line" '[[ $(notices) == 1 && $(thoughts) == 1 ]]'
run; run
ok "afterwards (STOPPED) no more stops or notices" '[[ $(stops) == 1 && $(notices) == 1 && $(thoughts) == 1 ]]'

# 2. idle only 40 min: nothing
fresh; fixture 40; echo RUNNING > "$F/status"; run; started_ago 120; run
ok "idle 40 min → no stop" '[[ $(stops) == 0 ]]'

# 3. each activity kind alone resets it (the rest 120 min old)
for k in sessions/s1/a.jsonl state/thoughts/I.thread.jsonl state/boards/I.jsonl outputs/x.png shared/new.txt; do
  fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120
  case "$k" in outputs/*|shared/*) p="$H/workspace/$k";; *) p="$H/.hyprpi-i/$k";; esac
  echo y > "$p"; touch -d "-10 min" "$p"; run
  ok "activity in $k (10 min ago) → no stop" '[[ $(stops) == 0 ]]'
done
# a file copied into shared with an OLD mtime (Unison keeps mtimes) still counts: the folder's listing changed since the last run
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; echo z > "$H/workspace/shared/old.txt"; touch -d "-300 min" "$H/workspace/shared/old.txt"; run
ok "new shared-folder file with an old mtime (listing changed) → no stop" '[[ $(stops) == 0 ]]'
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; rm "$H/workspace/shared/n.txt"; run
ok "a file deleted from the shared folder → no stop" '[[ $(stops) == 0 ]]'

# 4. vLLM: counter moved since the last run → active; a running request → active; unchanged → idle
fresh; fixture 120; echo RUNNING > "$F/status"; printf 'vllm:request_success_total{finished_reason="stop"} 5.0\nvllm:num_requests_running 0.0\n' > "$F/metrics"; run; started_ago 120
printf 'vllm:request_success_total{finished_reason="stop"} 7.0\nvllm:num_requests_running 0.0\n' > "$F/metrics"; run
ok "vLLM requests since the last run → no stop" '[[ $(stops) == 0 ]]'
BREV_AUTOSTOP_NOW=$(( $(date +%s) + 44*60 )) run
ok "…44 min after those requests: still no stop" '[[ $(stops) == 0 ]]'
BREV_AUTOSTOP_NOW=$(( $(date +%s) + 46*60 )) run
ok "…46 min after them (counter unchanged): stop" '[[ $(stops) == 1 ]]'
fresh; fixture 120; echo RUNNING > "$F/status"; printf 'vllm:request_success_total 9\nvllm:num_requests_running 1\n' > "$F/metrics"; run; started_ago 120; run
ok "vLLM request running now → no stop" '[[ $(stops) == 0 ]]'
fresh; fixture 120; echo RUNNING > "$F/status"; printf 'vllm:request_success_total 9\nvllm:num_requests_running 0\n' > "$F/metrics"; run; started_ago 120; run
ok "vLLM counter unchanged → stop" '[[ $(stops) == 1 ]]'

# 5. SSH-only login: no file changes (our own probe ran over ssh every time above, and these runs stop)
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; "$F/bin/ssh" hyprpi-l40s </dev/null >/dev/null 2>&1; run
ok "ssh logins alone (the probe's own included) → still stops" '[[ $(stops) == 1 && $(wc -l < "$F/sshcalls") -ge 2 ]]'

# 6. a freshly started box gets its 45 min even if every file is old
fresh; fixture 300; echo RUNNING > "$F/status"; run; run
ok "just started (first seen RUNNING now), files 5 h old → no stop" '[[ $(stops) == 0 ]]'

# 7. STOPPED / absent / brev ls error → nothing, and one log line per change (no spam)
for st in STOPPED absent error; do
  fresh; fixture 300; echo "$st" > "$F/status"; for i in 1 2 3 4 5; do run; done
  ok "$st → no ssh, no stop, no notice, 1 log line" '[[ ! -f "$F/sshcalls" && $(stops) == 0 && $(notices) == 0 && $(wc -l < "$F/state/log") == 1 ]]'
done

# 8. ssh fails → never stops on a guess, one log line
fresh; fixture 300; echo RUNNING > "$F/status"; run; started_ago 120; touch "$F/sshfail"; run; run; run
ok "probe over ssh fails → no stop, quiet" '[[ $(stops) == 0 && $(notices) == 0 && $(grep -c "over ssh" "$F/state/log") == 1 ]]'

# 9. a failing stop alerts once, retries hourly without new alerts
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; touch "$F/stopfail"; run; run; run
ok "stop fails → 1 critical alert, no retry within the hour" '[[ $(stops) == 1 && $(notices) == 1 && $(cnt critical) == 1 ]]'
echo $(( $(date +%s) - 3700 )) > "$F/state/stop_failed"; run
ok "…an hour later it retries, still no new alert" '[[ $(stops) == 2 && $(notices) == 1 ]]'
rm -f "$F/stopfail"; echo $(( $(date +%s) - 3700 )) > "$F/state/stop_failed"; run
ok "…and when the retry works, one 'stopped' notice" '[[ $(stops) == 3 && $(notices) == 2 && $(cnt "^notify.*stopped") == 1 ]]'

# 10. pause / resume
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; "$S" pause 2h >/dev/null; run
ok "paused for 2h → no stop" '[[ $(stops) == 0 ]]'
"$S" resume >/dev/null; run
ok "resumed → stops" '[[ $(stops) == 1 ]]'
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; "$S" pause >/dev/null; run
ok "paused until resume → no stop" '[[ $(stops) == 0 ]]'
echo $(( $(date +%s) - 60 )) > "$F/state/pause"; run
ok "a timed pause that ran out → stops" '[[ $(stops) == 1 ]]'

# 11. DRY=1 says, doesn't stop
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; BREV_AUTOSTOP_DRY=1 run
ok "DRY → no stop, logged" '[[ $(stops) == 0 ]] && grep -q "DRY: would stop" "$F/state/log"'

# 12. a pause given while a run is probing the box still holds
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; touch "$F/sshhold"; run & bg=$!
for i in $(seq 50); do [[ -f "$F/sshheld" ]] && break; sleep 0.1; done
"$S" pause 6h >/dev/null; rm -f "$F/sshhold"; wait $bg
ok "pause during the probe → that run doesn't stop" '[[ $(stops) == 0 ]] && grep -q "paused (during this run)" "$F/state/log"'

# 13. two runs at once: one stop, one notice
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; touch "$F/sshhold"; run & b1=$!
for i in $(seq 50); do [[ -f "$F/sshheld" ]] && break; sleep 0.1; done
run & b2=$!; sleep 0.5; rm -f "$F/sshhold"; wait $b1 $b2
ok "two runs at once → one stop, one notice, one Thoughts line" '[[ $(stops) == 1 && $(notices) == 1 && $(thoughts) == 1 ]]'

# 14. a stop that hangs (ignores TERM) is killed: the run ends and alerts
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; touch "$F/stophang"; t0=$(date +%s); BREV_AUTOSTOP_STOP_TIMEOUT=1 timeout 60 "$S" run; t1=$(date +%s)
ok "hanging brev stop → killed within ~16 s, one critical alert" '(( t1 - t0 < 30 )) && [[ $(cnt critical) == 1 ]]'

# 15. never touched the other instance (every stop of every case)
ok "only hyprpi-l40s was ever stopped (all cases)" '[[ $(grep -c . "$F/allcalls") -ge 8 ]] && ! grep -qv "^stop hyprpi-l40s$" "$F/allcalls"'

echo "$pass passed, $fail failed"; [[ $fail == 0 ]]
