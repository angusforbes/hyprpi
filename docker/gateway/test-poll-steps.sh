# J458 W2: both drop-box folders are polled every DROPBOX_POLL_MS (1 s), no fs.watch. Run inside the isolated gateway e2e:
#   E2E_STEPS=docker/gateway/test-poll-steps.sh bash docker/gateway/e2e.sh
# Five requests written into the sandbox's outbox at random moments: each must be consumed within ~1 s (the poll interval plus
# a scan) and its result must come back through the inbox (the relay's reply the gate polls).
E2E_RC=0; fail() { echo "FAIL $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
OUT=$R/x/ws/.hyprpi-dropbox/outbox; IN=$R/x/inbox; worst=0
ms() { date +%s%3N; }
got() { python3 -c "
import json,glob,sys
for f in glob.glob('$IN/*.json'):
  try: d=json.load(open(f))
  except Exception: continue
  if d.get('for')=='$1.json': sys.exit(0)
sys.exit(1)"; }
for i in 1 2 3 4 5; do
  sleep 0.$((RANDOM % 9 + 1))
  n=poll$i; echo "{\"op\":\"room.post\",\"text\":\"J458 poll test $i\"}" > $OUT/.$n.tmp && mv $OUT/.$n.tmp $OUT/$n.json; t0=$(ms)
  for _ in $(seq 1 60); do [ -e $OUT/$n.json ] || break; sleep 0.05; done; t1=$(ms)
  for _ in $(seq 1 60); do got $n && break; sleep 0.05; done; t2=$(ms)
  picked=$((t1 - t0)); back=$((t2 - t0)); echo "  request $i: picked up after ${picked} ms, result in the inbox after ${back} ms"
  [ $picked -gt $worst ] && worst=$picked
  [ -e $OUT/$n.json ] && fail "request $i still in the outbox after 3 s"
  got $n || fail "request $i: no result in the inbox"
done
[ $worst -le 1400 ] && ok "every outbox file was picked up within ~1 s (worst ${worst} ms)" || fail "slowest pickup ${worst} ms (> 1.4 s)"
grep -q "fs.watch(fdPath(dirs.outbox)" $H/docker/sbx-relay.mjs && fail "the relay still watches the outbox" || ok "the relay has no fs.watch on an outbox"
grep -q "DROPBOX_POLL_MS" $H/docker/world/g-gate.mjs && grep -q "DROPBOX_POLL_MS = 1000" $H/docker/dropbox-poll.mjs && ok "one shared interval (1000 ms) for the relay's outbox poll and the gate's inbox poll" || fail "interval not shared"
