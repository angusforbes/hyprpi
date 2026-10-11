# J453 steps for docker/gateway/e2e.sh: in every mode, every held item of a sandbox with a Doorman window (review_in) is routed to that
# window (reviewIn), listed by the window's provider, offered in no host Thoughts/room panel (A-F, H, I; G's own panels live inside the sandbox), and a decision made anywhere clears it within 2 s.
#   REVIEW_IN=1 HOSTAGENTS='"bridge"' E2E_STEPS=docker/doorman/test-window-steps.sh bash docker/gateway/e2e.sh
E2E_RC=0; fail() { echo "FAIL: $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
BR="$H/docker/bridge/doorman-bridge"; export DOORMAN_STATE=$P
$BR --json register E2E-Host --harness test >/dev/null; sleep 2
ids() { ls $P/pending 2>/dev/null | sed -n 's/\.json$//p'; }
lists() { node --input-type=module -e "const H=await import('$H/lib/held.mjs');const w=H.heldForSandboxes(['doorman-t','world-t']).map(x=>x.id);const p=['A','B','C','D','E','F','H','I'].flatMap(l=>H.heldFor(l).map(x=>x.id));console.log(JSON.stringify({w,p}))"; }
for MODE in strict safe open yolo; do
  echo "== $MODE"
  echo "{ \"sandbox\": \"world-t\", \"task\": \"Perovskite solar cells\", \"gateway\": { \"mode\": \"$MODE\" } }" > $XDG_CONFIG_HOME/hyprpi/worlds/world-t.json
  before=$(ids)
  W m1-$MODE '{"op":"talk","to":["Thoughts-B"],"text":"hello from '$MODE'"}'
  D n1-$MODE '{"op":"request","type":"note_to_owner","for":"Alpha","params":{"text":"note in '$MODE'"}}'
  D t1-$MODE '{"op":"task_change","for":"Alpha","task":"Perovskite stability in '$MODE'","why":"the work moved on"}'
  D d1-$MODE '{"op":"draft","for":"Alpha","why":"x","action":"something in '$MODE'"}'
  node $H/docker/sbx-relay.mjs propose-gateway world-t --changes '{"mode":"safe"}' --by e2e >/dev/null 2>&1
  sleep 2
  new=$(comm -13 <(echo "$before" | sort) <(ids | sort)); n=$(echo "$new" | grep -c .)
  [ "$n" -ge 1 ] && ok "$MODE: $n held item(s): $(for i in $new; do python3 -c "import json;d=json.load(open('$P/pending/$i.json'));print((d.get('typed') or {}).get('type') or ('task' if d.get('taskChange') else 'gateway' if d.get('gatewayChange') else 'draft' if d.get('draft') else 'message'))"; done | tr '\n' ' ')" || fail "$MODE: nothing held"
  for i in $new; do r=$(python3 -c "import json;d=json.load(open('$P/pending/$i.json'));print(d.get('reviewIn'),d.get('rooms'))"); [ "$r" = "doorman-t ['G']" ] || fail "$MODE $i not routed to the window: $r"; done
  L=$(lists); for i in $new; do case "$L" in *"\"w\":["*"\"$i\""*"],\"p\""*) ;; *) fail "$MODE $i not in the window's list: $L";; esac; case "$L" in *"\"p\":["*"\"$i\""*) fail "$MODE $i offered in a panel";; esac; done
  ok "$MODE: every held item routed to the Doorman window (reviewIn doorman-t), listed by its provider, in no panel"
  for i in $new; do
    printf 'phone' > $P/decisions/.$i.tmp; mv $P/decisions/.$i.tmp $P/decisions/$i.deny; t0=$(date +%s%N)
    while [ -f $P/pending/$i.json ] && [ $(( ($(date +%s%N) - t0) / 1000000 )) -lt 2000 ]; do sleep 0.05; done
    ms=$(( ($(date +%s%N) - t0) / 1000000 )); [ -f $P/pending/$i.json ] && fail "$MODE $i still pending after ${ms} ms" || echo "  $i cleared in ${ms} ms"
  done
  L=$(lists); for i in $new; do case "$L" in *"\"$i\""*) fail "$MODE $i still listed after the decision";; esac; done
  ok "$MODE: a decision made elsewhere (as the phone/toast write it) cleared every item from the window's list within 2 s"
done
