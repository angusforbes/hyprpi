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
      echo "You have 3 instances in Org test"; echo " NAME STATUS BUILD"; [[ "$st" != absent ]] && echo " hyprpi-l40s $st COMPLETED"; echo " keep-me-box $(cat "$F/nemo" 2>/dev/null || echo STOPPED) COMPLETED"; [[ -f "$F/more" ]] && sed 's/^/ /' "$F/more"; exit 0;;
  stop) echo "stop $2" >> "$F/calls"; echo "stop $2" >> "$F/allcalls"; [[ -f "$F/stophang" ]] && { trap "" TERM; sleep 30; }; [[ -f "$F/stopfail" ]] && { echo "boom" >&2; exit 1; }
        if [[ "$2" == hyprpi-l40s ]]; then if [[ -f "$F/stopresult" ]]; then cp "$F/stopresult" "$F/status"; else echo STOPPED > "$F/status"; fi; else sed -i "s/^$2 RUNNING/$2 STOPPED/" "$F/more"; fi; exit 0;;
esac
EOF
cat > "$F/bin/ssh" <<'EOF'
#!/usr/bin/env bash
F="$(cd "$(dirname "$0")/.." && pwd)"
echo "ssh $*" >> "$F/sshcalls"
[[ -f "$F/sshfail" ]] && exit 255
last="${@: -1}"
if [[ "$last" != "bash -s" ]]; then # J526: a plain remote command (the backup copy asking the primary for its heartbeat)
  host="${@: -2:1}"; [[ -f "$F/hubfail" ]] && exit 255; echo "$host" >> "$F/hubcalls"
  mkdir -p "$F/home-$host"; HOME="$F/home-$host" bash -c "$last"; exit
fi
[[ -f "$F/sshhold" ]] && { touch "$F/sshheld"; while [[ -f "$F/sshhold" ]]; do sleep 0.1; done; }
box=""; for a; do [[ "$a" == "bash -s" ]] && break; box="$a"; done # the argument just before the remote command
h="$F/home"; [[ -d "$F/home-$box" ]] && h="$F/home-$box"
BOXNAME="$box" HOME="$h" PATH="$F/bin:$PATH" bash -s
EOF
cat > "$F/bin/curl" <<'EOF'
#!/usr/bin/env bash
F="$(dirname "$0")/.."; [[ -f "$F/metrics" ]] && cat "$F/metrics" || exit 7
EOF
printf '#!/usr/bin/env bash\necho "notify $*" >> "%s/calls"\n' "$F" > "$F/bin/notify-send"
printf '#!/usr/bin/env bash\necho "hyprpi $*" >> "%s/calls"\n' "$F" > "$F/bin/hyprpi"
chmod +x "$F/bin/"*
printf 'exclude keep-me-box\n' > "$F/base.conf"
printf '#!/usr/bin/env bash\necho "ntfy $*" >> "%s/ntfy"; [[ -f "%s/ntfyfail" ]] && exit 7; exit 0\n' "$F" "$F" > "$F/bin/ntfycurl"; chmod +x "$F/bin/ntfycurl"
export BREV_AUTOSTOP_CURL="$F/bin/ntfycurl" BREV_AUTOSTOP_NTFY_FILE="$F/ntfy-topic" BREV_AUTOSTOP_NTFY_SERVER="https://ntfy.example"
export BREV_AUTOSTOP_ENV="$F/no-env" BREV_AUTOSTOP_CONFIG="$F/base.conf" BREV_AUTOSTOP_STATE="$F/state" BREV_AUTOSTOP_BREV="$F/bin/brev" BREV_AUTOSTOP_SSH="$F/bin/ssh" BREV_AUTOSTOP_NOTIFY="$F/bin/notify-send" BREV_AUTOSTOP_HYPRPI="$F/bin/hyprpi"
H="$F/home"
fixture() { # every activity file N minutes old
  rm -rf "$H"; mkdir -p "$H/.hyprpi-i/sessions/s1" "$H/.hyprpi-i/state/thoughts" "$H/.hyprpi-i/state/boards" "$H/workspace/outputs" "$H/workspace/shared"
  for f in "$H/.hyprpi-i/sessions/s1/a.jsonl" "$H/.hyprpi-i/state/thoughts/I.thread.jsonl" "$H/.hyprpi-i/state/boards/I.jsonl" "$H/workspace/outputs/x.png" "$H/workspace/shared/n.txt"; do echo x > "$f"; touch -d "-$1 min" "$f"; done
}
gpu_on() { printf '#!/usr/bin/env bash\nF="%s"; f="$F/gpu-$BOXNAME"; [[ -f "$f" ]] || f="$F/gpu"; [[ -f "$f" ]] && cat "$f"\n' "$F" > "$F/bin/nvidia-smi"; chmod +x "$F/bin/nvidia-smi"; }
fresh() { rm -rf "$F/stopresult" "$F/hubfail" "$F/hubcalls" "$F/home-hub"; rm -rf "$F/bin/nvidia-smi" "$F"/gpu* "$F/more" "$F/nemo" "$F"/home-* "$F/state"/* "$F/calls" "$F/sshcalls" "$F/stopfail" "$F/sshfail" "$F/metrics" "$F/stophang" "$F/sshhold" "$F/sshheld"; }
started_ago() { mkdir -p "$F/state/boxes/hyprpi-l40s"; echo $(( $(date +%s) - $1 * 60 )) > "$F/state/boxes/hyprpi-l40s/running_since"; } # pretend the timer first saw it RUNNING N min ago
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
  ok "$st → no ssh, no stop, no notice, at most 1 log line" '[[ ! -f "$F/sshcalls" && $(stops) == 0 && $(notices) == 0 && $(cat "$F/state/log" 2>/dev/null | wc -l) -le 1 ]]'
done

# 8. ssh fails → never stops on a guess, one log line
fresh; fixture 300; echo RUNNING > "$F/status"; run; started_ago 120; touch "$F/sshfail"; run; run; run
ok "probe over ssh fails → no stop, quiet" '[[ $(stops) == 0 && $(notices) == 0 && $(grep -c "over ssh" "$F/state/log") == 1 ]]'

# 9. a failing stop alerts once, retries hourly without new alerts
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; touch "$F/stopfail"; run; run; run
ok "stop fails → 1 critical alert, no retry within the hour" '[[ $(stops) == 1 && $(notices) == 1 && $(cnt critical) == 1 ]]'
echo $(( $(date +%s) - 3700 )) > "$F/state/boxes/hyprpi-l40s/stop_failed"; run
ok "…an hour later it retries, still no new alert" '[[ $(stops) == 2 && $(notices) == 1 ]]'
rm -f "$F/stopfail"; echo $(( $(date +%s) - 3700 )) > "$F/state/boxes/hyprpi-l40s/stop_failed"; run
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

# --- J516: every instance ---------------------------------------------------------------------------------------------------
fixture_for() { local b="$1" m="$2" h="$F/home-$1"; rm -rf "$h"; mkdir -p "$h/.hyprpi-x/sessions/s"; echo x > "$h/.hyprpi-x/sessions/s/a.jsonl"; touch -d "-$m min" "$h/.hyprpi-x/sessions/s/a.jsonl"; } # (a world X box; no shared folder)
started_ago_for() { mkdir -p "$F/state/boxes/$1"; echo $(( $(date +%s) - $2 * 60 )) > "$F/state/boxes/$1/running_since"; }
# 16. two RUNNING instances, handled independently: the idle one is stopped, the busy one isn't
fresh; fixture 120; echo RUNNING > "$F/status"; echo "train-a100 RUNNING COMPLETED" > "$F/more"; fixture_for train-a100 5
run; started_ago 120; started_ago_for train-a100 120; run
ok "two RUNNING: idle hyprpi-l40s stopped, busy train-a100 (5 min) not" '[[ $(stops) == 1 ]] && grep -qx "stop hyprpi-l40s" "$F/calls" && [[ $(thoughts) == 1 ]]'
touch -d "-120 min" "$F/home-train-a100/.hyprpi-x/sessions/s/a.jsonl"; BREV_AUTOSTOP_NOW=$(( $(date +%s) + 50*60 )) run
ok "…50 min after its last session write train-a100 is idle too: its own stop, its own notice naming it" '[[ $(stops) == 2 ]] && grep -qx "stop train-a100" "$F/calls" && grep -q "^notify.*Brev box train-a100" "$F/calls" && [[ $(thoughts) == 2 ]]'
# 17. an unknown new instance gets the default (45 min); a per-instance idle line overrides it
CF="$F/conf"; printf 'default_idle_min 45\nexclude keep-me-box\nidle slow-box 90\n' > "$CF"
fresh; fixture 120; echo STOPPED > "$F/status"; printf 'newbie RUNNING X\nslow-box RUNNING X\n' > "$F/more"; fixture_for newbie 120; fixture_for slow-box 120
BREV_AUTOSTOP_CONFIG="$CF" run; started_ago_for newbie 50; started_ago_for slow-box 50; BREV_AUTOSTOP_CONFIG="$CF" run
ok "unknown new instance → default 45 min → stopped at 50; slow-box (idle 90) not" '[[ $(stops) == 1 ]] && grep -qx "stop newbie" "$F/calls"'
started_ago_for slow-box 95; BREV_AUTOSTOP_CONFIG="$CF" run
ok "…slow-box stopped once past its own 90 min" '[[ $(stops) == 2 ]] && grep -qx "stop slow-box" "$F/calls"'
# 18. GPU utilisation counts (a training box with no hyprpi files): busy keeps it, idle GPU doesn't
fresh; echo STOPPED > "$F/status"; echo "train-a100 RUNNING X" > "$F/more"; fixture_for train-a100 300; gpu_on; printf '3\n87\n' > "$F/gpu-train-a100"
run; started_ago_for train-a100 120; run
ok "GPU at 87% (one of 2 GPUs) → no stop" '[[ $(stops) == 0 ]] && grep -q "GPU busy (87%)" "$F/state/log"'
printf '4\n' > "$F/gpu-train-a100"; BREV_AUTOSTOP_NOW=$(( $(date +%s) + 30*60 )) run
ok "…GPU drops to 4%: 30 min after the last busy sample → no stop yet" '[[ $(stops) == 0 ]]'
BREV_AUTOSTOP_NOW=$(( $(date +%s) + 50*60 )) run
ok "…50 min after the last busy sample → stopped" '[[ $(stops) == 1 ]]'
fresh; echo STOPPED > "$F/status"; echo "train-a100 RUNNING X" > "$F/more"; fixture_for train-a100 300; gpu_on; printf '10\n' > "$F/gpu-train-a100"
run; started_ago_for train-a100 120; run
ok "GPU exactly at the threshold (10%) is idle → stopped" '[[ $(stops) == 1 ]]'
# 19. per-instance pause holds for that box only
fresh; fixture 120; echo RUNNING > "$F/status"; echo "train-a100 RUNNING X" > "$F/more"; fixture_for train-a100 120
run; started_ago 120; started_ago_for train-a100 120; "$S" pause train-a100 24h >/dev/null; run
ok "pause train-a100 24h → it stays, hyprpi-l40s is still stopped" '[[ $(stops) == 1 ]] && grep -qx "stop hyprpi-l40s" "$F/calls"'
"$S" resume train-a100 >/dev/null; run
ok "resume train-a100 → stopped" '[[ $(stops) == 2 ]] && grep -qx "stop train-a100" "$F/calls"'
# 20. an excluded instance is never probed or stopped, even RUNNING and idle (default config and an explicit one)
fresh; echo STOPPED > "$F/status"; echo RUNNING > "$F/nemo"; fixture 300; run; started_ago_for keep-me-box 300; run; run
ok "keep-me-box RUNNING + idle, excluded in the config → never probed, never stopped" '[[ $(stops) == 0 && ! -f "$F/sshcalls" ]]'
printf 'exclude keep-me-box\nexclude keep-me\n' > "$CF"; echo "keep-me RUNNING X" > "$F/more"; BREV_AUTOSTOP_CONFIG="$CF" run; started_ago_for keep-me 300; BREV_AUTOSTOP_CONFIG="$CF" run
ok "an excluded instance in the config → never probed, never stopped" '[[ $(stops) == 0 && ! -f "$F/sshcalls" ]]'
# 21. install: links, enables the timer if missing, registers the instance, says so; idempotent
IB="$F/ibin"; IC="$F/iconf/brev-autostop.conf"; SC="$F/bin/systemctl"; rm -f "$F/sysd"
printf '#!/usr/bin/env bash\nF="%s"; echo "systemctl $*" >> "$F/syscalls"\ncase "$*" in *is-enabled*) [[ -f "$F/sysd" ]];; *is-active*) [[ -f "$F/sysd" ]];; *enable*) touch "$F/sysd";; esac\n' "$F" > "$SC"; chmod +x "$SC"
i1="$(BREV_AUTOSTOP_CONFIG="$IC" BREV_AUTOSTOP_BIN="$IB" BREV_AUTOSTOP_SYSTEMCTL="$SC" "$S" install train-a100)"
ok "install (first time): link + timer enabled + registered + 'auto-stop is on for train-a100'" '[[ -L "$IB/brev-autostop" ]] && grep -q "enable --now brev-autostop.timer" "$F/syscalls" && grep -qx "box train-a100" "$IC" && grep -q "auto-stop is on for train-a100: stopped after 45 idle minutes" <<<"$i1"'
i2="$(BREV_AUTOSTOP_CONFIG="$IC" BREV_AUTOSTOP_BIN="$IB" BREV_AUTOSTOP_SYSTEMCTL="$SC" "$S" install train-a100)"
ok "install again: nothing new (one line), config line not duplicated, timer not re-enabled" '[[ $(grep -c . <<<"$i2") == 1 && $(grep -c "^box train-a100" "$IC") == 1 && $(grep -c "enable --now" "$F/syscalls") == 1 ]]'
echo "exclude keep-me-box" >> "$IC"; i3="$(BREV_AUTOSTOP_CONFIG="$IC" BREV_AUTOSTOP_BIN="$IB" BREV_AUTOSTOP_SYSTEMCTL="$SC" "$S" install keep-me-box)"
ok "install of an excluded instance says so and doesn't register it" '! grep -q "^box keep-me-box" "$IC" && grep -q "EXCLUDED" <<<"$i3"'
# 28. no config file at all → nothing probed or stopped, one log line
fresh; fixture 300; echo RUNNING > "$F/status"; started_ago 300; for i in 1 2 3; do BREV_AUTOSTOP_CONFIG="$F/none.conf" run; done
ok "no config file → never probes or stops anything, one log line" '[[ $(stops) == 0 && ! -f "$F/sshcalls" && $(grep -c "no config" "$F/state/log") == 1 ]]'
# 29. the example config names no real instance and excludes nothing by itself
ok "the example config has no exclude line in force" '! grep -q "^exclude" "$HERE/brev/autostop/brev-autostop.conf.example"'

# 23. setup-hook (what `world X setup` runs): a Brev box from its binding gets auto-stop; anything else is silent
rm -f "$IC" "$F/syscalls" "$F/sysd" "$IB/brev-autostop"; echo STOPPED > "$F/status"; echo "math-a100 RUNNING X" > "$F/more"
envi=(BREV_AUTOSTOP_CONFIG="$IC" BREV_AUTOSTOP_BIN="$IB" BREV_AUTOSTOP_SYSTEMCTL="$SC")
printf '{"ssh":["ssh","math-a100"],"prefix":"brev-"}\n' > "$F/b1.json"; printf '{"ssh":["tsh","ssh","agf@omni-host"]}\n' > "$F/b2.json"; printf '{"ssh":["ssh","alias"],"brev":"math-a100"}\n' > "$F/b3.json"
h1="$(env "${envi[@]}" "$S" setup-hook "$F/b1.json")"
ok "setup-hook, Brev binding → timer enabled, math-a100 registered, 'auto-stop is on for math-a100'" 'grep -q "enabled the laptop timer" <<<"$h1" && grep -q "auto-stop is on for math-a100" <<<"$h1" && grep -qx "box math-a100" "$IC"'
h2="$(env "${envi[@]}" "$S" setup-hook "$F/b2.json")"; rc2=$?
ok "setup-hook, an Omnistation (non-Brev) binding → silent, exit 0, nothing registered" '[[ -z "$h2" && $rc2 == 0 ]] && ! grep -q omni "$IC"'
h3="$(env "${envi[@]}" "$S" setup-hook "$F/b3.json")"
ok "setup-hook again (\"brev\" field) → idempotent: one line, nothing added" '[[ $(grep -c . <<<"$h3") == 1 && $(grep -c "^box math-a100" "$IC") == 1 && $(grep -c "enable --now" "$F/syscalls") == 1 ]]'
# 24. the real `omnistation/world X setup`, scratch: binding with a dead ssh stub (setup stops at "couldn't reach"), the hook runs first
printf '#!/usr/bin/env bash\nexit 255\n' > "$F/bin/deadssh"; chmod +x "$F/bin/deadssh"; printf '{"ssh":["%s","math-a100"]}\n' "$F/bin/deadssh" > "$F/b4.json"
rm -f "$IC" "$F/syscalls" "$F/sysd"
w4="$(env "${envi[@]}" HYPRPI_REMOTE_CONF="$F/b4.json" "$HERE/omnistation/world" I setup 2>&1)"
ok "world I setup (scratch) prints 'auto-stop is on for math-a100' before reaching the box" 'grep -q "auto-stop is on for math-a100" <<<"$w4" && grep -qx "box math-a100" "$IC"'
w5="$(env "${envi[@]}" HYPRPI_REMOTE_CONF="$F/b4.json" "$HERE/omnistation/world" I setup 2>&1)"
ok "…run again: same one line, nothing re-enabled or duplicated" '[[ $(grep -c "auto-stop" <<<"$w5") == 1 && $(grep -c "^box math-a100" "$IC") == 1 && $(grep -c "enable --now" "$F/syscalls") == 1 ]]'

# 25. (FleetStopCheck) a CRLF config still excludes and sets limits; "08" is decimal
printf 'default_idle_min 90\r\nexclude protected\r\nexclude keep-me-box\r\n' > "$CF"
fresh; echo STOPPED > "$F/status"; printf 'protected RUNNING X\nother RUNNING X\n' > "$F/more"; fixture_for protected 300; fixture_for other 300
BREV_AUTOSTOP_CONFIG="$CF" run; started_ago_for protected 300; started_ago_for other 50; BREV_AUTOSTOP_CONFIG="$CF" run
ok "CRLF config: excluded box never probed or stopped; default 90 holds (other at 50 min kept)" '[[ $(stops) == 0 ]] && ! grep -q protected "$F/sshcalls"'
printf 'default_idle_min 08\ngpu_busy_pct 08\n' > "$CF"
fresh; echo STOPPED > "$F/status"; echo "box8 RUNNING X" > "$F/more"; fixture_for box8 300; gpu_on; printf '90\n' > "$F/gpu-box8"
BREV_AUTOSTOP_CONFIG="$CF" run; started_ago_for box8 60; BREV_AUTOSTOP_CONFIG="$CF" run 2>"$F/err"
ok "'08' settings are decimal: GPU 90% > 8 keeps the box, no arithmetic error" '[[ $(stops) == 0 && ! -s "$F/err" ]]'
printf '3\n' > "$F/gpu-box8"; BREV_AUTOSTOP_NOW=$(( $(date +%s) + 9*60 )) BREV_AUTOSTOP_CONFIG="$CF" run 2>"$F/err"
ok "…GPU idle 9 min later, limit 08 = 8 min → stopped" '[[ $(stops) == 1 && ! -s "$F/err" ]]'
# 26. a box whose name looks like a duration: `pause 24h 1h` pauses THAT box; `pause 24h forever` too; one argument = all
fresh; fixture 120; echo RUNNING > "$F/status"; echo "24h RUNNING X" > "$F/more"; fixture_for 24h 120
run; started_ago 120; started_ago_for 24h 120; "$S" pause 24h 1h >/dev/null
ok "pause 24h 1h → a pause file for the box '24h', no global pause" '[[ -f "$F/state/boxes/24h/pause" && ! -f "$F/state/pause" ]]'
run
ok "…box 24h kept, hyprpi-l40s still stopped" '[[ $(stops) == 1 ]] && grep -qx "stop hyprpi-l40s" "$F/calls"'
"$S" pause 3h >/dev/null; "$S" resume all >/dev/null
ok "pause 3h = all boxes; resume all clears it" '[[ ! -f "$F/state/pause" ]]'
# 27. install with the timer enabled but not running: started; if it won't start, a failure (not "auto-stop is on")
printf '#!/usr/bin/env bash\nF="%s"; echo "systemctl $*" >> "$F/syscalls"\ncase "$*" in *is-enabled*) exit 0;; *is-active*) exit 3;; *start*) [[ -f "$F/startok" ]];; esac\n' "$F" > "$SC"
rm -f "$F/startok"; i4="$(BREV_AUTOSTOP_CONFIG="$IC" BREV_AUTOSTOP_BIN="$IB" BREV_AUTOSTOP_SYSTEMCTL="$SC" "$S" install z9 2>&1)"; rc4=$?
ok "install: timer enabled but won't start → exit 1, says so, no 'auto-stop is on'" '[[ $rc4 == 1 ]] && grep -q "won.t start" <<<"$i4" && ! grep -q "auto-stop is on" <<<"$i4"'
touch "$F/startok"; i5="$(BREV_AUTOSTOP_CONFIG="$IC" BREV_AUTOSTOP_BIN="$IB" BREV_AUTOSTOP_SYSTEMCTL="$SC" "$S" install z9 2>&1)"
ok "…when it starts: 'started brev-autostop.timer' + 'auto-stop is on for z9'" 'grep -q "started brev-autostop.timer" <<<"$i5" && grep -q "auto-stop is on for z9" <<<"$i5"'

# --- J523: a box stuck UNHEALTHY -----------------------------------------------------------------------------------------------
unh_ago() { mkdir -p "$F/state/boxes/hyprpi-l40s"; echo $(( $(date +%s) - $1 * 60 )) > "$F/state/boxes/hyprpi-l40s/unh_since"; }
tried_ago() { echo $(( $(date +%s) - $1 * 60 )) > "$F/state/boxes/hyprpi-l40s/unh_tried"; }
crit() { cnt "^notify.*-u critical"; }
# 30. under the limit: nothing; at the limit: one stop + one alert with the status after it
fresh; echo UNHEALTHY > "$F/status"; run; unh_ago 30; run; run
ok "UNHEALTHY 30 min (< 45) → no stop, no alert, no ssh" '[[ $(stops) == 0 && $(notices) == 0 && ! -f "$F/sshcalls" ]]'
unh_ago 50; run
ok "UNHEALTHY 50 min → one brev stop + one notice + one Thoughts line, with the status after it" '[[ $(stops) == 1 && $(notices) == 1 && $(thoughts) == 1 ]] && grep -q "Status now: STOPPED" "$F/calls"'
run; run
ok "…then STOPPED: nothing more" '[[ $(stops) == 1 && $(notices) == 1 ]]'
# 31. the stop fails: one critical alert, quiet hourly retries, one notice when a retry works
fresh; echo UNHEALTHY > "$F/status"; run; unh_ago 50; touch "$F/stopfail"; run; run; run
ok "stop fails → one critical alert with the status, no retry within the hour" '[[ $(stops) == 1 && $(notices) == 1 && $(crit) == 1 ]] && grep -q "status now: UNHEALTHY" "$F/calls"'
tried_ago 61; run
ok "…an hour later: retried, no new alert" '[[ $(stops) == 2 && $(notices) == 1 ]]'
rm -f "$F/stopfail"; tried_ago 61; run
ok "…a retry that works: one 'STOPPED now' notice" '[[ $(stops) == 3 && $(notices) == 2 ]] && grep -q "is STOPPED now" "$F/calls"'
# 32. the stop lands in a failed state (J512): one alert saying so, then quiet hourly retries
fresh; echo UNHEALTHY > "$F/status"; run; unh_ago 50; echo STOPPING_FAILED > "$F/stopresult"; run
ok "stop → STOPPING_FAILED right away → one critical alert naming it" '[[ $(stops) == 1 && $(crit) == 1 ]] && grep -q "status now: STOPPING_FAILED" "$F/calls"'
run; run; tried_ago 61; run
ok "…still STOPPING_FAILED: no more alerts, one quiet retry after the hour" '[[ $(stops) == 2 && $(notices) == 1 ]]'
fresh; echo UNHEALTHY > "$F/status"; run; unh_ago 50; echo STOPPING > "$F/stopresult"; run
ok "stop → STOPPING: one normal notice with that status" '[[ $(stops) == 1 && $(notices) == 1 && $(crit) == 0 ]] && grep -q "Status now: STOPPING" "$F/calls"'
echo STOPPING_FAILED > "$F/status"; run; run
ok "…later STOPPING_FAILED: one more (critical) alert, then none" '[[ $(notices) == 2 && $(crit) == 1 ]] && grep -q "now .STOPPING_FAILED. after the stop" "$F/calls"'
# 32b. (UnhealthyCheck) a STOPPING poll in between keeps the spell: STOPPING → STOPPING_FAILED still alerts, retry stays hourly
fresh; echo UNHEALTHY > "$F/status"; run; unh_ago 50; echo STOPPING > "$F/stopresult"; run; run
ok "stop → STOPPING, polled again while STOPPING → spell kept (no new stop, no alert)" '[[ $(stops) == 1 && $(notices) == 1 && -f "$F/state/boxes/hyprpi-l40s/unh_tried" ]]'
echo STOPPING_FAILED > "$F/status"; run; run
ok "…then STOPPING_FAILED → one critical alert, no stop within the hour" '[[ $(stops) == 1 && $(crit) == 1 && $(notices) == 2 ]]'
# 32c. a failed first stop, a retry that goes STOPPING, then STOPPED → one 'STOPPED now'
fresh; echo UNHEALTHY > "$F/status"; run; unh_ago 50; touch "$F/stopfail"; run; rm -f "$F/stopfail"; tried_ago 61; echo STOPPING > "$F/stopresult"; run; run
ok "failed stop, retry → STOPPING: followed, no new alert" '[[ $(stops) == 2 && $(notices) == 1 ]]'
echo STOPPED > "$F/status"; run; run
ok "…then STOPPED → exactly one 'STOPPED now' notice" '[[ $(notices) == 2 && $(cnt "^notify.*is STOPPED now") == 1 ]]'

# 33. a paused box: alerted once, never stopped
fresh; echo UNHEALTHY > "$F/status"; run; unh_ago 50; "$S" pause hyprpi-l40s 24h >/dev/null; run; run; run
ok "paused + UNHEALTHY 50 min → one alert, no stop" '[[ $(stops) == 0 && $(notices) == 1 && $(crit) == 1 ]] && grep -q "paused, so it was NOT stopped" "$F/calls"'
"$S" resume hyprpi-l40s >/dev/null; run
ok "…resumed → stopped, with its own outcome notice" '[[ $(stops) == 1 && $(notices) == 2 ]] && grep -q "Status now: STOPPED" "$F/calls"'
# 34. an excluded box, UNHEALTHY for hours: untouched
fresh; echo STOPPED > "$F/status"; echo UNHEALTHY > "$F/nemo"; for i in 1 2 3; do run; done; mkdir -p "$F/state/boxes/keep-me-box"; echo $(( $(date +%s) - 300*60 )) > "$F/state/boxes/keep-me-box/unh_since"; run
ok "excluded box UNHEALTHY → never stopped, no alert" '[[ $(stops) == 0 && $(notices) == 0 ]]'
# 35. UNHEALTHY → RUNNING → UNHEALTHY starts a new spell; per-box limit; config default
fresh; fixture 5; echo UNHEALTHY > "$F/status"; run; unh_ago 40; echo RUNNING > "$F/status"; run; echo UNHEALTHY > "$F/status"; run
ok "a RUNNING moment ends the spell (a new one starts at 0) → no stop" '[[ $(stops) == 0 ]]'
printf 'exclude keep-me-box\nunhealthy hyprpi-l40s 120\n' > "$CF"; fresh; echo UNHEALTHY > "$F/status"; BREV_AUTOSTOP_CONFIG="$CF" run; unh_ago 90; BREV_AUTOSTOP_CONFIG="$CF" run
ok "unhealthy hyprpi-l40s 120 → no stop at 90 min" '[[ $(stops) == 0 ]]'
printf 'exclude keep-me-box\ndefault_unhealthy_min 20\n' > "$CF"; BREV_AUTOSTOP_CONFIG="$CF" run
ok "default_unhealthy_min 20 → stopped at 90 min" '[[ $(stops) == 1 ]]'

# --- J526: the laptop copy as the hub copy's backup ---------------------------------------------------------------------------
hub_ran() { mkdir -p "$F/home-hub/.local/state/brev-autostop"; echo $(( $(date +%s) - $1 * 60 )) > "$F/home-hub/.local/state/brev-autostop/heartbeat"; }
backup() { BREV_AUTOSTOP_PRIMARY=hub run; }
# 36. the hub's copy ran 3 min ago → the backup does nothing, even with an idle box
fresh; fixture 120; echo RUNNING > "$F/status"; hub_ran 3; backup; started_ago 120; backup; backup
ok "backup, hub fresh (3 min) → only the heartbeat question: no probe, no stop, no notice" '[[ $(stops) == 0 && $(notices) == 0 && $(wc -l < "$F/hubcalls") == 3 ]] && ! grep -q "bash -s" "$F/sshcalls"'
ok "…and one 'standing by' log line" '[[ $(grep -c "standing by" "$F/state/log") == 1 ]]'
# 37. the hub's heartbeat is 20 min old → the backup acts (stops the idle box) and says so once
hub_ran 20; backup; backup; backup
ok "backup, hub stale (20 min) → acts: one stop, one 'backup is checking' alert" '[[ $(stops) == 1 && $(cnt "^notify.*backup copy is checking") == 1 && $(cnt "^hyprpi thoughts alert A .*backup copy is checking") == 1 ]]'
# 38. the hub comes back → one notice, then standby again (no more stops or alerts)
echo RUNNING > "$F/status"; started_ago 120; hub_ran 1; backup; backup
ok "hub back → one 'running again' notice, standing by, no stop" '[[ $(stops) == 1 && $(cnt "^notify.*running again") == 1 ]]'
# 39. the hub can't be reached, or has never run → acts, alert names why, once
fresh; fixture 120; echo RUNNING > "$F/status"; touch "$F/hubfail"; backup; started_ago 120; backup; backup
ok "hub unreachable < 15 min → waits: no stop, no alert" '[[ $(stops) == 0 && $(notices) == 0 ]] && grep -q "waiting 15 min" "$F/state/log"'
echo $(( $(date +%s) - 16*60 )) > "$F/state/unreach_since"; backup; backup
ok "hub unreachable 16 min → acts (one stop), one alert 'can't be reached'" '[[ $(stops) == 1 && $(cnt "^notify.*can.t be reached") == 1 ]]'
fresh; fixture 120; echo RUNNING > "$F/status"; backup; started_ago 120; backup
ok "hub never ran (no heartbeat) → acts, alert says so" '[[ $(stops) == 1 && $(cnt "^notify.*never run") == 1 ]]'
# 39b. while acting, limits get +10 min (a working primary would stop first)
fresh; fixture 120; echo RUNNING > "$F/status"; hub_ran 30; backup; started_ago 50; backup
ok "backup acting, idle 50 min (45+10 margin) → not yet" '[[ $(stops) == 0 ]]'
started_ago 56; backup
ok "…idle 56 min → stopped" '[[ $(stops) == 1 ]]'
# 39c. the hub's brev ls failing writes no heartbeat (so a backup takes over), ours too
fresh; echo error > "$F/status"; run; run
ok "brev ls failing → no heartbeat written" '[[ ! -f "$F/state/heartbeat" ]]'
# 39d. a hand run reads the env file deploy-hub wrote (PRIMARY there → standby with a fresh hub)
fresh; fixture 120; echo RUNNING > "$F/status"; hub_ran 2; printf 'BREV_AUTOSTOP_PRIMARY=hub\nBAD LINE\nOTHER=x\n' > "$F/envf"; BREV_AUTOSTOP_ENV="$F/envf" run; started_ago 120; BREV_AUTOSTOP_ENV="$F/envf" run
ok "hand run with the env file → standby (no stop)" '[[ $(stops) == 0 ]] && grep -q "standing by" "$F/state/log"'
so="$(BREV_AUTOSTOP_ENV="$F/envf" "$S" status 2>/dev/null)"
ok "…status says BACKUP" 'grep -q "BACKUP of the copy on hub" <<<"$so"'
# 39e. pause / resume on the backup is passed on to the primary
mkdir -p "$F/home-hub/.local/bin"; printf '#!/usr/bin/env bash\necho "$*" >> "%s/hubpause"; echo ok-there\n' "$F" > "$F/home-hub/.local/bin/brev-autostop"; chmod +x "$F/home-hub/.local/bin/brev-autostop"; rm -f "$F/hubpause"
po="$(BREV_AUTOSTOP_PRIMARY=hub "$S" pause train-a100 24h)"; BREV_AUTOSTOP_PRIMARY=hub "$S" resume train-a100 >/dev/null
ok "pause/resume on the backup → also run on the hub (same arguments)" '[[ "$(cat "$F/hubpause")" == "pause train-a100 24h"$'"'"'\n'"'"'"resume train-a100" ]] && grep -q "hub: ok-there" <<<"$po"'
# 40. without BREV_AUTOSTOP_PRIMARY it is the main copy: never asks anyone (the hub's own copy)
fresh; fixture 120; echo RUNNING > "$F/status"; run; started_ago 120; run
ok "no PRIMARY → no heartbeat question, acts as before; writes its own heartbeat" '[[ ! -f "$F/hubcalls" && $(stops) == 1 && -f "$F/state/heartbeat" ]]'
# 41. a bad PRIMARY value is refused, nothing done
fresh; fixture 120; echo RUNNING > "$F/status"; BREV_AUTOSTOP_PRIMARY='x;rm -rf /' run; started_ago 120; BREV_AUTOSTOP_PRIMARY='x;rm -rf /' run
ok "bad PRIMARY → nothing done" '[[ $(stops) == 0 && ! -f "$F/hubcalls" ]]'

# --- J527: phone notifications through ntfy ------------------------------------------------------------------------------------
posts() { [[ -f "$F/ntfy" ]] && grep -c . "$F/ntfy" || echo 0; }
PC="$F/phone.conf"; printf 'exclude keep-me-box\n' > "$PC"
# 42. off by default: no post, even on a stop
fresh; rm -f "$F/ntfy" "$F/ntfy-topic"; fixture 120; echo RUNNING > "$F/status"; BREV_AUTOSTOP_CONFIG="$PC" run; started_ago 120; BREV_AUTOSTOP_CONFIG="$PC" run
ok "phone off (default) → a stop posts nothing" '[[ $(stops) == 1 && $(posts) == 0 ]]'
# 43. phone on: makes a 600 topic file, sets the config; a routine stop posts once, priority default
o="$(BREV_AUTOSTOP_CONFIG="$PC" "$S" phone on)"; tp="$(cat "$F/ntfy-topic")"
ok "phone on → topic file 600 (≥ 20 chars), config 'notify_phone on'" '[[ $(stat -c %a "$F/ntfy-topic") == 600 && ${#tp} -ge 20 ]] && grep -qx "notify_phone on" "$PC"'
fresh; rm -f "$F/ntfy"; fixture 120; echo RUNNING > "$F/status"; BREV_AUTOSTOP_CONFIG="$PC" run; started_ago 120; BREV_AUTOSTOP_CONFIG="$PC" run; BREV_AUTOSTOP_CONFIG="$PC" run
ok "routine stop → one post, priority default, to server/topic, titled with the box" '[[ $(posts) == 1 ]] && grep -q "Priority: default" "$F/ntfy" && grep -qF "https://ntfy.example/$tp" "$F/ntfy" && grep -q "Title: Brev box hyprpi-l40s" "$F/ntfy"'
ok "…the topic is in no log line" '! grep -qF "$tp" "$F/state/log"'
# 44. a failed stop → one post, priority high; hourly retries post nothing
fresh; rm -f "$F/ntfy"; fixture 120; echo RUNNING > "$F/status"; BREV_AUTOSTOP_CONFIG="$PC" run; started_ago 120; touch "$F/stopfail"; for i in 1 2 3; do BREV_AUTOSTOP_CONFIG="$PC" run; done
ok "failed stop → one post, priority high" '[[ $(posts) == 1 ]] && grep -q "Priority: high" "$F/ntfy"'
# 45. UNHEALTHY → stop: one post with the status; a paused UNHEALTHY box: one high post
fresh; rm -f "$F/ntfy"; echo UNHEALTHY > "$F/status"; BREV_AUTOSTOP_CONFIG="$PC" run; unh_ago 50; BREV_AUTOSTOP_CONFIG="$PC" run; BREV_AUTOSTOP_CONFIG="$PC" run
ok "UNHEALTHY → stopped → one post saying the status" '[[ $(posts) == 1 ]] && grep -q "Status now: STOPPED" "$F/ntfy"'
fresh; rm -f "$F/ntfy"; echo UNHEALTHY > "$F/status"; BREV_AUTOSTOP_CONFIG="$PC" run; unh_ago 50; BREV_AUTOSTOP_CONFIG="$PC" "$S" pause hyprpi-l40s 2h >/dev/null; BREV_AUTOSTOP_CONFIG="$PC" run; BREV_AUTOSTOP_CONFIG="$PC" run
ok "UNHEALTHY + paused → one high post" '[[ $(posts) == 1 ]] && grep -q "Priority: high" "$F/ntfy"'
# 46. backup taking over → one high post; hub back → one default post
fresh; rm -f "$F/ntfy"; fixture 120; echo RUNNING > "$F/status"; hub_ran 30; BREV_AUTOSTOP_CONFIG="$PC" BREV_AUTOSTOP_PRIMARY=hub run; BREV_AUTOSTOP_CONFIG="$PC" BREV_AUTOSTOP_PRIMARY=hub run
ok "backup takes over → one high post" '[[ $(posts) == 1 ]] && grep -q "Priority: high" "$F/ntfy"'
hub_ran 1; BREV_AUTOSTOP_CONFIG="$PC" BREV_AUTOSTOP_PRIMARY=hub run; BREV_AUTOSTOP_CONFIG="$PC" BREV_AUTOSTOP_PRIMARY=hub run
ok "…hub back → one more post, priority default" '[[ $(posts) == 2 ]] && tail -1 "$F/ntfy" | grep -q "Priority: default"'
# 47. ntfy unreachable: the run still stops, the other channels still get it
fresh; rm -f "$F/ntfy"; touch "$F/ntfyfail"; fixture 120; echo RUNNING > "$F/status"; BREV_AUTOSTOP_CONFIG="$PC" run; started_ago 120; BREV_AUTOSTOP_CONFIG="$PC" run; rc=$?
ok "ntfy failing → the run still stops (exit 0), desktop + Thoughts still notified, log says no phone" '[[ $rc == 0 && $(stops) == 1 && $(notices) == 1 && $(thoughts) == 1 ]] && ! grep -q "phone" <(grep notice "$F/state/log")'
rm -f "$F/ntfyfail"
# 48. phone off → no post; test command; a bad topic file → nothing posted
BREV_AUTOSTOP_CONFIG="$PC" "$S" phone off >/dev/null
fresh; rm -f "$F/ntfy"; fixture 120; echo RUNNING > "$F/status"; BREV_AUTOSTOP_CONFIG="$PC" run; started_ago 120; BREV_AUTOSTOP_CONFIG="$PC" run
ok "phone off → stop posts nothing; one notify_phone line" '[[ $(stops) == 1 && $(posts) == 0 && $(grep -c "^notify_phone" "$PC") == 1 ]]'
BREV_AUTOSTOP_CONFIG="$PC" "$S" phone on >/dev/null; rm -f "$F/ntfy"; to="$(BREV_AUTOSTOP_CONFIG="$PC" "$S" phone test)"
ok "phone test → one post, 'test sent'; the same topic kept" '[[ $(posts) == 1 && "$to" == "test sent" && "$(cat "$F/ntfy-topic")" == "$tp" ]]'
echo "short" > "$F/ntfy-topic"; rm -f "$F/ntfy"; BREV_AUTOSTOP_CONFIG="$PC" "$S" phone test 2>/dev/null
ok "an invalid topic file → nothing posted" '[[ $(posts) == 0 ]]'
# 49. phone on with a primary: the same topic is stored there and turned on there
mkdir -p "$F/home-hub/.local/bin"; printf '#!/usr/bin/env bash\nif [[ "$*" == "phone set-topic" ]]; then cat > "%s/hubtopic"; echo "topic stored (600)"; else echo "$*" >> "%s/hubphone"; echo ok; fi\n' "$F" "$F" > "$F/home-hub/.local/bin/brev-autostop"; chmod +x "$F/home-hub/.local/bin/brev-autostop"
echo "$tp" > "$F/ntfy-topic"; rm -f "$F/hubtopic" "$F/hubphone"; BREV_AUTOSTOP_CONFIG="$PC" BREV_AUTOSTOP_PRIMARY=hub "$S" phone on >/dev/null
ok "phone on (backup) → the hub gets the same topic and 'phone on'" '[[ "$(tr -d "\n" < "$F/hubtopic")" == "$tp" ]] && grep -qx "phone on" "$F/hubphone"'

# 22. junk in brev ls (its "You have N instances" line) is never taken for an instance
fresh; fixture 120; echo STOPPED > "$F/status"; run
ok "brev ls's header lines are not instances" '[[ ! -d "$F/state/boxes/You" && ! -d "$F/state/boxes/NAME" ]]'

# 15. never touched the other instance (every stop of every case)
ok "keep-me-box was never stopped (all cases)" '[[ $(grep -c . "$F/allcalls") -ge 8 ]] && ! grep -q keep-me-box "$F/allcalls"'

echo "$pass passed, $fail failed"; [[ $fail == 0 ]]
