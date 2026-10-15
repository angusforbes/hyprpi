#!/usr/bin/env bash
# J663 (no silent success, Angus's 38a): copying a remote machine's new generated images (~/workspace/outputs PNGs) to the laptop
# never leaves a truncated PNG behind that then counts as "already there". Both copiers:
#   W) omnistation/world X images (brev-sync's "pullworld" pairs, and by hand)
#   B) brev/sync/brev-sync's own pull (a pair with "pull")
# A stand-in ssh runs the remote command against a local folder ($T/outputs); with $T/cut it cuts the tar stream off half way
# (exit 255 = the connection dropped, or exit 0 = a stream that just ends). Each copier must then: fail visibly (non-zero exit and
# a message; brev-sync: the pair counts a failure and logs why), keep NO partial file, and copy the image whole on the next run.
# A PNG written in the last 10 s waits for a later run. No network, no box, no daemon, no windows.
#   node test/run.mjs test/images-pull-cutoff.sh   (exit 0 = pass)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; fails=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
mkdir -p "$T/bin" "$T/outputs" "$T/dest" "$T/cfg/hyprpi" "$T/xs" "$T/Brev"
cat > "$T/bin/ssh" <<EOF
#!/bin/bash
# a stand-in: ssh [opts] HOST CMD -> CMD run here with ~/workspace/outputs = $T/outputs; \$T/cut holds the exit code of a cut-off copy
cmd="\${@: -1}"; cmd="\${cmd//\~\/workspace\/outputs/$T/outputs}"
if [[ -e "$T/cut" && "\$cmd" == *"tar -cf"* ]]; then bash -c "\$cmd" | head -c 150000; exit "\$(cat "$T/cut")"; fi
exec bash -c "\$cmd"
EOF
printf '#!/bin/sh\necho "NAME STATUS"\necho "j663-box RUNNING"\n' > "$T/bin/brev"
printf '#!/bin/sh\necho "Synchronization complete at 00:00:00  (0 items transferred, 0 skipped, 0 failed)"; exit 0\n' > "$T/bin/unison"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/notify-send"; printf '#!/bin/sh\nexit 0\n' > "$T/bin/hyprpi"
chmod +x "$T"/bin/*
echo "{\"ssh\":[\"$T/bin/ssh\",\"host\"]}" > "$T/i.json"
img() { head -c 400000 /dev/urandom > "$T/outputs/$1"; touch -d '1 minute ago' "$T/outputs/$1"; }
img big-1.png; img big-2.png
export PATH="$T/bin:$PATH"

# ---- W) world X images
wimages() { HYPRPI_REMOTE_CONF="$T/i.json" HYPRPI_IMAGES_DIR="$T/dest" XDG_CONFIG_HOME="$T/cfg" "$ROOT/omnistation/world" I images > "$T/w.out" 2> "$T/w.err"; }
for code in 255 0; do
  echo "$code" > "$T/cut"; rm -f "$T/dest"/*.png
  wimages; rc=$?
  ok "W cut off (stand-in ssh exit $code): world images exits non-zero" "[[ $rc -ne 0 ]]"
  ok "W … and says the copy failed and nothing was kept" "grep -q 'failed (cut off?): none kept' $T/w.err"
  ok "W … no partial PNG left in the folder (it would count as copied forever)" "! ls $T/dest/*.png >/dev/null 2>&1"
  ok "W … no file:// link printed for an image that didn't arrive whole" "! grep -q '^file://' $T/w.out"
  ok "W … no staging folder left behind" "[[ -z \"\$(ls -A $T/dest)\" ]]"
done
rm -f "$T/cut"; wimages; rc=$?
ok "W next run (link healthy): exit 0, both images whole, both linked" "[[ $rc -eq 0 ]] && cmp -s $T/outputs/big-1.png $T/dest/big-1.png && cmp -s $T/outputs/big-2.png $T/dest/big-2.png && [[ \$(grep -c '^file://' $T/w.out) -eq 2 ]]"
head -c 1000 /dev/urandom > "$T/outputs/fresh.png"; wimages
ok "W a PNG written in the last 10 s waits (not copied yet)" "[[ ! -e $T/dest/fresh.png ]] && grep -q 'no new images' $T/w.out"
touch -d '1 minute ago' "$T/outputs/fresh.png"; wimages
ok "W … and is copied once it's settled" "cmp -s $T/outputs/fresh.png $T/dest/fresh.png"
rm -f "$T/outputs/fresh.png"

# ---- B) brev-sync's own pull (pair option "pull")
echo "$T/Brev j663-box workspace/shared pull" > "$T/cfg/hyprpi/brev-sync.conf"
bsync() { XDG_CONFIG_HOME="$T/cfg" XDG_STATE_HOME="$T/xs" BREV_SYNC_UNISON="$T/bin/unison" "$ROOT/brev/sync/brev-sync" 2> "$T/b.err"; }
PS="$T/xs/brev-sync/pairs/j663-box"
echo 255 > "$T/cut"; bsync; rc=$?
ok "B cut off: brev-sync exits 1 (a failure while the box runs)" "[[ $rc -eq 1 ]]"
ok "B … the pair's state says the pull failed and why" "[[ \$(cat $PS/state) == pull-failed ]] && grep -q 'cut off: none kept' $T/xs/brev-sync/sync.log && grep -q 'cut off: none kept' $T/b.err"
ok "B … counted as a failure (toward the alert)" "[[ \$(cat $PS/fails) == 1 ]]"
ok "B … no partial PNG and no staging folder left in the synced folder" "[[ -z \"\$(ls -A $T/Brev)\" ]]"
echo 0 > "$T/cut"; bsync
ok "B a stream that just ends (ssh exit 0): still no partial PNG, second failure" "[[ -z \"\$(ls -A $T/Brev)\" && \$(cat $PS/fails) == 2 ]]"
rm -f "$T/cut"; bsync; rc=$?
ok "B next run: exit 0, both images whole, failures back to 0" "[[ $rc -eq 0 ]] && cmp -s $T/outputs/big-1.png $T/Brev/big-1.png && cmp -s $T/outputs/big-2.png $T/Brev/big-2.png && [[ \$(cat $PS/fails) == 0 ]]"
ok "B … and the log counts 2 pulled" "grep -q 'pulled from outputs: 2 image' $T/xs/brev-sync/sync.log"

[[ $fails -eq 0 ]] && { echo "all passed"; rm -rf "$T"; } || echo "$fails FAILED (state $T)"
exit $fails
