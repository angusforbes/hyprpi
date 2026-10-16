#!/bin/bash
# J670 benchmark: fast-browse (JEV step picker) on the two bench tasks, N runs each, against a THROWAWAY Brave on PORT.
# Each run's result is checked independently (the page's own text, read with a separate agent-browser session), not
# only by JEV's "done". Prints one line per run and a summary. The JEV key is read by fast-browse; nothing here prints it.
# Usage: bench/browser/jev-bench.sh PORT [RUNS]   (serve bench/browser on 127.0.0.1:8669 first)
set -u
P=${1:?port}; N=${2:-3}; D=$(cd "$(dirname "$0")" && pwd); FB=${FB:-$D/../../bin/fast-browse}
check() { # $1 = text the task's tab must show; closes that tab
  local AB="agent-browser --cdp $P --session jevbench-check-$$" idx ok=1
  idx=$($AB tab list 2>/dev/null | grep "127.0.0.1:8669" | tail -1 | grep -o "\[t[0-9]*\]" | tr -d '[]')
  [[ -n "$idx" ]] && $AB tab "$idx" >/dev/null 2>&1 && $AB get text body 2>/dev/null | grep -qF "$1" && ok=0
  [[ -n "$idx" ]] && $AB tab close >/dev/null 2>&1
  return $ok
}
fails=0
task() { # name, expected text, fast-browse args...
  local name=$1 want=$2; shift 2
  local out; out=$("$FB" --cdp "$P" --keep-tab --json "$@" 2>&1); local rc=$?
  local line; line=$(jq -r '"\(.status) steps=\(.steps|length) ms=\(.ms) tokens=\(.tokens) usd=\(.cost_usd)"' <<<"$out" 2>/dev/null || echo "ERROR $out")
  if check "$want"; then line="$line page=ok"; else line="$line page=WRONG"; fails=$((fails+1)); fi
  [[ $rc == 0 ]] || fails=$((fails+1))
  echo "$name: $line"
}
for i in $(seq 1 "$N"); do
  task "form#$i" "Submitted: Angus / angus@example.com / plan=Pro / agree=yes / file=upload.txt" \
    --url http://127.0.0.1:8669/ --input name=Angus --input email=angus@example.com --input plan=Pro --file upload="$D/upload.txt" \
    --verify "The page shows: Submitted: Angus / angus@example.com / plan=Pro / agree=yes / file=upload.txt" \
    "Fill the upload form with the name, email and plan given, agree to the terms, attach the upload file and submit it"
  task "shop#$i" "Order placed: 2 × Blue widget, Express shipping, to Angus, 1 Test Street" \
    --url http://127.0.0.1:8669/shop/ --input quantity=2 --input full_name=Angus --input address="1 Test Street" \
    --verify "The page confirms an order placed for 2 × Blue widget, Express shipping, to Angus, 1 Test Street" \
    "Order 2 Blue widgets with Express shipping, to the full name and address given"
done
echo "failures: $fails"; exit $(( fails > 0 ))
