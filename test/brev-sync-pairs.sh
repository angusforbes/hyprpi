#!/usr/bin/env bash
# J547 proof (Angus: "we should make a shared folder for the hub cpu instsance, like ~/Brev/Hub or something"): brev-sync with
# two pairs from a config file, ~/Brev <-> gpu:~/workspace/shared (pull, ignore=Hub) and ~/Brev/Hub <-> hub:~/workspace/shared.
# The REAL Unison 2.54 syncs, with each "box" a local folder ($T/boxes/<box>): a wrapper turns ssh://BOX/REMOTE into that
# folder. A fake brev says which boxes run; a fake hyprpi / notify-send record alerts. Nothing leaves the machine.
#   bash test/brev-sync-pairs.sh   (exit 0 = pass)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; fails=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
REAL_UNISON="${REAL_UNISON:-$HOME/.local/lib/unison-2.54.0/unison}"
[[ -x "$REAL_UNISON" ]] || { echo "skip: no unison at $REAL_UNISON"; exit 0; }
mkdir -p "$T/bin" "$T/home/Brev" "$T/boxes/gpu/workspace/shared" "$T/boxes/hub/workspace/shared" "$T/boxes/gpu/workspace/outputs" "$T/cfg/hyprpi"
printf '#!/bin/sh\necho "NAME STATUS"\ncat %s/boxes.txt\n' "$T" > "$T/bin/brev"
# unison: the remote root ssh://BOX/PATH becomes $T/boxes/BOX/PATH; ssh options dropped; a box listed in $T/broken fails as unreachable
cat > "$T/bin/unison" <<EOF
#!/bin/bash
a=(); skip=0; box=""
for x in "\$@"; do
  if (( skip )); then skip=0; continue; fi
  case "\$x" in -servercmd|-sshargs) skip=1; continue;; ssh://*) r="\${x#ssh://}"; box="\${r%%/*}"; x="$T/boxes/\$box/\${r#*/}";; esac
  a+=("\$x")
done
grep -qx "\$box" "$T/broken" 2>/dev/null && { echo "Fatal error: Lost connection with the server" >&2; exit 3; }
echo "\$box \$*" >> "$T/unison-calls.log"
exec "$REAL_UNISON" "\${a[@]}"
EOF
# ssh for the pull: runs the command with ~/workspace/outputs pointing at the box folder
cat > "$T/bin/ssh" <<EOF
#!/bin/bash
args=("\$@"); cmd="\${args[-1]}"; box="\${args[-2]}"; cmd="\${cmd//\~\/workspace\/outputs/$T/boxes/\$box/workspace/outputs}"
exec bash -c "\$cmd"
EOF
printf '#!/bin/sh\necho "hyprpi $*" >> %s/alerts.log\n' "$T" > "$T/bin/hyprpi"
printf '#!/bin/sh\necho "notify $*" >> %s/alerts.log\n' "$T" > "$T/bin/notify-send"
chmod +x "$T"/bin/*
cat > "$T/cfg/hyprpi/brev-sync.conf" <<EOF
# test pairs
~/Brev       gpu  workspace/shared  pull ignore=Hub
~/Brev/Hub   hub  workspace/shared
EOF
run() { HOME="$T/home" PATH="$T/bin:$PATH" XDG_CONFIG_HOME="$T/cfg" XDG_STATE_HOME="$T/state" BREV_SYNC_UNISON="$T/bin/unison" "$ROOT/brev/sync/brev-sync" 2>>"$T/stderr"; }
printf 'gpu RUNNING\nhub RUNNING\n' > "$T/boxes.txt"
mkdir -p "$T/home/Brev/Hub"

echo laptop-hub > "$T/home/Brev/Hub/to-hub.txt"; echo hub-side > "$T/boxes/hub/workspace/shared/from-hub.txt"
echo laptop-gpu > "$T/home/Brev/to-gpu.txt"; echo gpu-side > "$T/boxes/gpu/workspace/shared/from-gpu.txt"
echo png > "$T/boxes/gpu/workspace/outputs/img-1.png"
run; rc=$?
ok "both pairs run in one go, exit 0" "[[ $rc -eq 0 ]] && grep -q '^gpu ' $T/unison-calls.log && grep -q '^hub ' $T/unison-calls.log"
ok "W2 a file dropped in ~/Brev/Hub reaches the hub" "[[ -f $T/boxes/hub/workspace/shared/to-hub.txt ]]"
ok "W2 a file dropped on the hub reaches ~/Brev/Hub" "[[ -f $T/home/Brev/Hub/from-hub.txt ]]"
ok "W3 the GPU pair still works both ways" "[[ -f $T/boxes/gpu/workspace/shared/to-gpu.txt && -f $T/home/Brev/from-gpu.txt ]]"
ok "W3 the GPU pair still pulls new images from outputs" "[[ -f $T/home/Brev/img-1.png && -f $T/boxes/gpu/workspace/shared/img-1.png ]]"
ok "W3 the GPU box never sees Hub's folder or files" "[[ ! -e $T/boxes/gpu/workspace/shared/Hub ]] && ! find $T/boxes/gpu -name 'to-hub.txt' -o -name 'from-hub.txt' | grep -q ."
ok "W3 the hub never sees the GPU box's files" "! find $T/boxes/hub -name 'to-gpu.txt' -o -name 'from-gpu.txt' -o -name 'img-1.png' | grep -q ."
ok "W3 the GPU pair passes -ignore 'Path Hub', the hub pair doesn't" "grep '^gpu ' $T/unison-calls.log | grep -q 'Path Hub' && ! grep '^hub ' $T/unison-calls.log | grep -q 'Path Hub'"

# W2 conflict: both sides change the same file → the newer wins, the other is kept next to it
echo "laptop edit" >> "$T/home/Brev/Hub/to-hub.txt"; sleep 1.2; echo "hub edit" >> "$T/boxes/hub/workspace/shared/to-hub.txt"
run; run
cf="$(ls "$T/home/Brev/Hub" | grep 'to-hub (conflict_on_' | head -1)"
ok "W2 conflict keeps both copies" '[[ -n "$cf" ]] && grep -q "hub edit" "$T/home/Brev/Hub/to-hub.txt" && grep -q "laptop edit" "$T/home/Brev/Hub/$cf"'

# W3 per-pair failures: the hub unreachable 3 runs while the GPU pair works → exit 1, ONE alert naming the hub pair
echo hub > "$T/broken"; : > "$T/alerts.log"
run; r1=$?; run; run; r3=$?
ok "W3 a failing hub pair makes the run exit 1" "[[ $r1 -eq 1 && $r3 -eq 1 ]]"
ok "W3 after 3 failures one alert, naming the hub pair (both channels)" "[[ \$(grep -c '^hyprpi thoughts alert' $T/alerts.log) -eq 1 ]] && grep -q 'Brev/Hub <-> hub' $T/alerts.log && grep -q '^notify' $T/alerts.log"
ok "W3 … and the GPU pair kept syncing meanwhile (its own state: ok, 0 failures)" "[[ \$(cat $T/state/brev-sync/pairs/gpu/state) == ok && \$(cat $T/state/brev-sync/pairs/gpu/fails) == 0 ]]"
run; ok "W3 no repeat alert" "[[ \$(grep -c '^hyprpi thoughts alert' $T/alerts.log) -eq 1 ]]"
: > "$T/broken"; run; rc=$?
ok "W3 recovery: exit 0, one 'working again' for the hub pair" "[[ $rc -eq 0 ]] && grep -q 'working again (~/Brev/Hub <-> hub' $T/alerts.log"
# a stopped box: a quiet pause for that pair only
printf 'gpu STOPPED\nhub RUNNING\n' > "$T/boxes.txt"; : > "$T/unison-calls.log"; run; rc=$?
ok "a stopped GPU box: exit 0, only the hub pair syncs" "[[ $rc -eq 0 ]] && ! grep -q '^gpu ' $T/unison-calls.log && grep -q '^hub ' $T/unison-calls.log"
# emptying one side by hand: Unison's safety stop (confirmbigdel) is reported as that, not as a connection problem
rm -f "$T/home/Brev/Hub/"*; run; rc=$?
ok "emptying ~/Brev/Hub by hand: exit 1, logged as Unison's safety stop (not 'unreachable')" "[[ $rc -eq 1 ]] && grep -q 'safety stop' $T/state/brev-sync/sync.log && [[ \$(cat $T/state/brev-sync/pairs/hub/state) == both-sides-differ ]]"
rm -f "$T/boxes/hub/workspace/shared/"*; run; rc=$?
ok "… emptied on both sides: ok again" "[[ $rc -eq 0 && \$(cat $T/state/brev-sync/pairs/hub/state) == ok ]]"
ok "status lists both pairs" "HOME=$T/home PATH=$T/bin:\$PATH XDG_CONFIG_HOME=$T/cfg XDG_STATE_HOME=$T/state $ROOT/brev/sync/brev-sync status | grep -c ' <-> .*: box ' | grep -qx 2"
[[ $fails -eq 0 ]] && { echo "all passed"; rm -rf "$T"; } || echo "$fails FAILED (state $T)"
exit $fails
