#!/usr/bin/env bash
# J497 proof (Angus: "shouldn't we notice a failure"): brev/sync/brev-sync with stubs (no box, no real Brev, no real daemon):
#   a stopped box exits 0 (a quiet pause); a failure while the box is RUNNING exits 1; after 3 failures in a row ONE ⚠ alert
#   lands in a scratch daemon's Thoughts-Z thread; more failures don't repeat it; the first success after it sends ONE
#   "working again". The stubs: brev (prints the box's state), unison and the world pull's ssh (fail while $T/broken exists).
#   bash test/brev-sync-failures.sh   (exit 0 = pass)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; fails=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
mkdir -p "$T/bin" "$T/outputs" "$T/cfg/hyprpi" "$T/Brev"
printf '#!/bin/sh\necho "NAME STATUS"\necho "j497-box $(cat %s/boxstate)"\n' "$T" > "$T/bin/brev"
printf '#!/bin/sh\n[ -e %s/broken ] && { echo "ssh: connect to host j497-box: Connection refused" >&2; echo "Fatal error: Lost connection with the server" >&2; exit 3; }\necho "Synchronization complete at 00:00:00  (0 items transferred, 0 skipped, 0 failed)"; exit 0\n' "$T" > "$T/bin/unison"
printf '#!/bin/bash\n[ -e %s/broken ] && { echo "ssh: Connection refused" >&2; exit 255; }\ncmd="${@: -1}"; cmd="${cmd//\\~\\/workspace\\/outputs/%s/outputs}"; exec bash -c "$cmd"\n' "$T" "$T" > "$T/bin/fakessh"
printf '#!/bin/sh\necho "$*" >> %s/notify.log\n' "$T" > "$T/bin/notify-send"
chmod +x "$T"/bin/*
echo "{\"ssh\":[\"$T/bin/fakessh\",\"host\"]}" > "$T/i.json"
echo '{"roomToThoughts":false,"pi":"/bin/cat","worldSize":10}' > "$T/cfg/hyprpi/config.json"
echo '{"auth":{"enabled":false},"upkeep":{"refresh":{"enabled":false},"autoReload":{"enabled":false}}}' > "$T/cfg/hyprpi/hyprpi.jsonc"
export HYPRPI_SOCKET="$T/d.sock" HYPRPI_STATE="$T/state" XDG_CONFIG_HOME="$T/cfg" HYPRPI_TEST=1 HYPRPI_NO_ENSURE=1 HYPRPI_UPKEEP_MS=3600000
unset HYPRPI_AGENT_ID HYPRPI_WORKSPACE
node "$ROOT/bin/hyprpi" daemon > "$T/d.log" 2>&1 & D=$!
trap 'kill $D 2>/dev/null; wait $D 2>/dev/null; [[ $fails -eq 0 ]] && rm -rf "$T"' EXIT
for _ in $(seq 50); do [[ -S "$T/d.sock" ]] && break; sleep 0.2; done
run() { PATH="$T/bin:$ROOT/bin:$PATH" XDG_STATE_HOME="$T/xs" BREV_SYNC_BOX=j497-box BREV_SYNC_DIR="$T/Brev" BREV_SYNC_UNISON="$T/bin/unison" \
  HYPRPI_REMOTE_CONF="$T/i.json" BREV_SYNC_ALERT_WORLD=Z "$ROOT/brev/sync/brev-sync" 2>/dev/null; }
alerts() { node -e 'import(process.argv[1]).then(async ({connect}) => { const a = await connect({ path: process.env.HYPRPI_SOCKET, onEvent: () => {} }); const g = await a.call("thoughts.get", { room: "Z", limit: 100 }); console.log(g.entries.filter((e) => e.role === "note" && /brev-sync/.test(e.text)).length); process.exit(0); })' "$ROOT/lib/client.mjs"; }

echo STOPPED > "$T/boxstate"; run; ok "W1 stopped box: exit 0" "[[ $? -eq 0 ]]"
: > "$T/boxstate"; run; ok "W1 box absent from brev ls: exit 0" "[[ $? -eq 0 ]]"
echo RUNNING > "$T/boxstate"; run; ok "W1 running box, sync works: exit 0" "[[ $? -eq 0 ]]"
touch "$T/broken"
run; r1=$?; run; r2=$?
ok "W1 running box, ssh/unison failing: exit 1 (twice)" "[[ $r1 -eq 1 && $r2 -eq 1 ]]"
ok "W2 no alert after 2 failures" "[[ \$(alerts) -eq 0 && ! -e $T/notify.log ]]"
run; ok "W2 third failure: exit 1" "[[ $? -eq 1 ]]"
ok "W2 one ⚠ alert in Thoughts-Z's thread after 3" "[[ \$(alerts) -eq 1 ]]"
ok "W2 one desktop notification (critical)" "[[ \$(grep -c critical $T/notify.log) -eq 1 ]]"
run; run; run
ok "W2 no repeat alert on failures 4-6" "[[ \$(alerts) -eq 1 && \$(wc -l < $T/notify.log) -eq 1 ]]"
echo STOPPED > "$T/boxstate"; run; ok "W1 box stops mid-outage: exit 0, no alert" "[[ $? -eq 0 && \$(alerts) -eq 1 ]]"
echo RUNNING > "$T/boxstate"; rm "$T/broken"; run
ok "W2 recovery: exit 0, one 'working again'" "[[ $? -eq 0 && \$(alerts) -eq 2 ]] && grep -q 'working again' $T/notify.log"
run; ok "W2 no repeat recovery notice" "[[ \$(alerts) -eq 2 && \$(wc -l < $T/notify.log) -eq 2 ]]"
ok "log has no per-run spam while stopped" "[[ \$(grep -c paused $T/xs/brev-sync/sync.log) -le 3 ]]"
echo "--- sync.log"; cat "$T/xs/brev-sync/sync.log"
[[ $fails -eq 0 ]] && echo "all passed" || echo "$fails FAILED (state $T)"
exit $fails
