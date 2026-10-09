#!/usr/bin/env bash
# Read-only mount re-test for Docker Sandboxes (J307, decision 7a). Checks that a folder mounted :ro INSIDE an rw
# parent mount really stays read-only against the agent and sudo, after each sbx update.
# Runs ONLY in the sbxprobe sandbox (never world-g), on a scratch folder ~/Work/sbx-rotest-auto.
#   ro-retest.sh            run now
#   ro-retest.sh --if-new   run only if the recorded sbx version differs from the current one
# Exit 0 = ro held, 1 = something got through (printed), 2 = the test could not run.
# Result: ~/.local/state/hyprpi/sbx-ro-retest.json {sbx, at, result, exit, leaks}. (A world.sh start line:
#   docker/world/ro-retest.sh --if-new >&2 || echo "WARNING: sbx read-only mounts leak, see sbx-ro-retest.json" >&2 )
set -u
SB=sbxprobe
HOST="$HOME/Work/sbx-rotest-auto"
RO="$HOST/ro"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/hyprpi"
OUT="$STATE/sbx-ro-retest.json"
ver=$(sbx version 2>/dev/null | head -1 | sed 's/^sbx version: *//; s/ .*//')
[ -n "$ver" ] || { echo "ro-retest: cannot read sbx version" >&2; exit 2; }

record() { # result exit leaks
  mkdir -p "$STATE"
  python3 - "$OUT" "$ver" "$1" "$2" "$3" <<'PY'
import json, sys, datetime
o, ver, res, code, leaks = sys.argv[1:6]
json.dump({"sbx": ver, "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "result": res,
           "exit": int(code), "leaks": [l for l in leaks.split("\n") if l]}, open(o, "w"), indent=1)
PY
}

if [ "${1:-}" = "--if-new" ]; then
  last=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sbx",""))' "$OUT" 2>/dev/null || true)
  if [ "$last" = "$ver" ]; then echo "ro-retest: sbx $ver already tested; skipping"; exit 0; fi
fi

was_running=0
sbx ls 2>/dev/null | awk -v s="$SB" '$1==s && $4=="running"{f=1} END{exit !f}' && was_running=1
mounted=0
cleanup() {
  [ -e "$HOST" ] || true
  sbx umount "$SB" "$RO" >/dev/null 2>&1
  sbx umount "$SB" "$HOST" >/dev/null 2>&1
  [ "$was_running" = 1 ] || sbx stop "$SB" >/dev/null 2>&1
  rm -rf "$HOST"
}
trap cleanup EXIT
fail() { echo "ro-retest: could not run: $*" >&2; record "could-not-run: $*" 2 ""; exit 2; }

sbx ls 2>/dev/null | awk -v s="$SB" '$1==s{f=1} END{exit !f}' || fail "sandbox $SB missing"
rm -rf "$HOST"; mkdir -p "$RO" || fail "mkdir"
echo canary-top > "$HOST/canary-top.txt"; echo canary-ro > "$RO/canary.txt"
snap() { (cd "$HOST" && find . -printf '%p %y %s\n' | sort; sha256sum canary-top.txt ro/canary.txt); }
before=$(snap)
sbx exec "$SB" true >/dev/null 2>&1 || fail "cannot start $SB"
sbx mount "$SB" "$HOST" >/dev/null 2>&1 || fail "mount rw"
sbx mount "$SB" "$RO:$RO:ro" >/dev/null 2>&1 || fail "mount ro"

inner=$(cat <<'IN'
H="$1"
sudo_ok=0; sudo -n true 2>/dev/null && sudo_ok=1
echo "info sudo=$sudo_ok mounts:"; grep -F "$H" /proc/self/mountinfo | awk '{print "info  "$5" "$6}'
[ "$(cat "$H/ro/canary.txt" 2>/dev/null)" = canary-ro ] || { echo "NORUN canary not readable inside"; exit 0; }
try() { # label command...   success of the write command = LEAK
  l=$1; shift
  if "$@" >/dev/null 2>&1; then echo "LEAK $l"; else echo "held $l"; fi
}
for base in "$H" "/mnt/host$H"; do
  if [ ! -d "$base/ro" ]; then echo "info no $base/ro (path absent: not testable)"; continue; fi
  for who in "" "sudo -n"; do
    [ -n "$who" ] && [ "$sudo_ok" = 0 ] && continue
    t="${who:-agent} $base/ro"
    try "create $t"  $who sh -c "echo x > '$base/ro/new-$$.txt'"
    try "append $t"  $who sh -c "echo x >> '$base/ro/canary.txt'"
    try "touch $t"   $who touch "$base/ro/canary.txt"
    try "mkdir $t"   $who mkdir "$base/ro/newdir-$$"
    try "mv-in $t"   $who sh -c "echo y > '$H/outside-$$.txt' && mv '$H/outside-$$.txt' '$base/ro/moved-in.txt'"
    try "mv $t"      $who mv "$base/ro/canary.txt" "$base/ro/canary2.txt"
    try "rm $t"      $who rm -f "$base/ro/canary.txt"
    rm -f "$H/outside-$$.txt" 2>/dev/null
  done
done
if [ "$sudo_ok" = 1 ]; then
  if sudo -n umount "$H/ro" >/dev/null 2>&1; then
    echo "info sudo umount of the ro mount SUCCEEDED (inside the sandbox)"
    try "write through parent after umount $H/ro" sh -c "echo x > '$H/ro/after-umount-$$.txt'"
  else echo "held sudo umount $H/ro"; fi
fi
echo "info done"
IN
)
res=$(sbx exec "$SB" bash -c "$inner" _ "$HOST" 2>&1) || true
echo "$res"
echo "$res" | grep -q '^NORUN' && fail "canary not readable inside $SB"
echo "$res" | grep -q '^info done' || fail "inner script did not finish"

leaks=$(echo "$res" | grep '^LEAK' || true)
after=$(snap 2>&1)
hostdiff=""
[ "$before" = "$after" ] || hostdiff=$(diff <(echo "$before") <(echo "$after") | grep '^[<>]' | sed 's/^/HOST CHANGED: /')
[ -n "$hostdiff" ] && echo "$hostdiff"
all=$(printf '%s\n%s' "$leaks" "$hostdiff" | sed '/^$/d')
if [ -z "$all" ]; then
  echo "ro-retest: sbx $ver: read-only held (canary sha256 unchanged)"; record held 0 ""; exit 0
fi
echo "ro-retest: sbx $ver: READ-ONLY BROKEN:"; echo "$all"; record broken 1 "$all"; exit 1
