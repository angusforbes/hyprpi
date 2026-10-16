#!/bin/bash
# J669 benchmark, fast path: fill + upload + submit the local test form by page structure over CDP (agent-browser),
# in a NEW tab it closes afterwards (never navigates an existing tab).
# Usage: bench/browser/fast.sh PORT [RUNS]   (PORT 9222 = Angus's Brave; a throwaway Brave on another port for tests)
# Needs the form served: (cd bench/browser && python3 -m http.server 8669 --bind 127.0.0.1)
# One agent turn = read the page (snapshot) + one batch of all actions with the result read back.
set -u
P=${1:?port}; N=${2:-5}; D=$(cd "$(dirname "$0")" && pwd); AB="agent-browser --cdp $P --session j669bench-$$"
timeout 30 $AB tab new http://127.0.0.1:8669/ >/dev/null || { echo "cannot open a tab on port $P" >&2; exit 1; }
trap 'timeout 30 $AB tab close >/dev/null 2>&1' EXIT
for i in $(seq 1 "$N"); do
  t0=$(date +%s.%N)
  timeout 30 $AB open http://127.0.0.1:8669/ >/dev/null
  timeout 30 $AB snapshot -i -c > /dev/null
  t1=$(date +%s.%N)
  out=$(timeout 30 $AB batch --bail "fill #name Angus" "fill #email angus@example.com" "select #plan Pro" "check #agree" "upload #file $D/upload.txt" "click button[type=submit]" "get text #out" 2>&1 | tail -1)
  t2=$(date +%s.%N)
  printf 'run %d: read %.2fs, act+verify %.2fs, total %.2fs | %s\n' "$i" "$(echo "$t1-$t0" | bc)" "$(echo "$t2-$t1" | bc)" "$(echo "$t2-$t0" | bc)" "$out"
done
