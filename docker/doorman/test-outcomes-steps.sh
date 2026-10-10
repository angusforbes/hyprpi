# J395 (Angus chose a Doorman with no memory at all): the asking agent hears the outcome of every draft from the relay itself, and nothing
# the Doorman receives carries any earlier exchange. Steps for docker/gateway/e2e.sh (its test daemon + relay, fake sandbox and Doorman):
#   E2E_STEPS=docker/doorman/test-outcomes-steps.sh bash docker/gateway/e2e.sh
FAILS=0; chk() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
# (J412: a decision reaches the asker as one {type: "receipt", for, text}; shown here as "for: [Outside] text" like the other outcomes)
G() { python3 -c "import json,glob
for f in sorted(glob.glob('$R/x/inbox/*.json')):
  try: d=json.load(open(f))
  except Exception: continue
  print(d.get('for','')+': [Outside] '+d.get('text','') if d.get('type')=='receipt' else json.dumps(d, ensure_ascii=False))"; }
echo "== draft for Alpha, approved"; D o1 '{"op":"draft","for":"Alpha","why":"needs a share","action":"share proj read-only"}'; ID=$(ls $P/pending/ | sed -n 's/\.json$//p' | head -1); printf 'terminal\n' > $P/decisions/$ID.approve; sleep 4
chk "Alpha hears that its draft $ID was approved, from the relay" "G | grep -q 'Alpha: \[Outside\] Angus approved the request drafted for you ($ID)'"
chk "… and Thoughts-G does NOT get a copy (J412: asker-only receipt)" "! G | grep -q 'drafted for you ($ID).*(asked by Alpha)'"
echo "== draft for Beta, denied with a reason"; D o2 '{"op":"draft","for":"Beta","why":"wants a host","action":"allow example.com"}'; ID2=$(ls $P/pending/ | sed -n 's/\.json$//p' | head -1)
printf 'terminal\nnote:%s\n' "$(printf 'not on this laptop' | base64 -w0)" > $P/decisions/$ID2.deny; sleep 4
chk "Beta hears its draft $ID2 was denied, with Angus's reason" "G | grep -q 'Beta: \[Outside\] Angus denied the request drafted for you ($ID2): nothing was done.*Note from Angus: .not on this laptop.'"
chk "Alpha's outcome never went to Beta and vice versa" "! G | grep -q 'Beta: \[Outside\] Angus approved the request drafted for you ($ID)'"
echo "== task change for Gamma (J368 route)"; D o3 '{"op":"task_change","task":"Perovskite stability","why":"moved on","for":"Gamma"}'; ID3=$(ls $P/pending/ | sed -n 's/\.json$//p' | head -1); printf 'terminal\n' > $P/decisions/$ID3.approve; sleep 4
chk "Gamma hears the task change outcome" "G | grep -q 'Gamma: \[Outside\] Angus approved the research task change ($ID3)'"
echo "== typed request for Alpha (J368 route)"; D o4 '{"op":"request","type":"note_to_owner","for":"Alpha","params":{"text":"render done"}}'; ID4=$(ls $P/pending/ | sed -n 's/\.json$//p' | head -1); printf 'terminal\n' > $P/decisions/$ID4.deny; sleep 4
chk "Alpha hears the typed request outcome" "G | grep -q 'Alpha: \[Outside\] Angus denied the request.*($ID4)'"
echo "== the Doorman's own inbox: two questions from different agents carry nothing earlier"
W o5 '{"op":"talk","to":["Doorman-T"],"mode":"demand","text":"[Alpha, in world G] is pypi.org allowed? SECRET-A"}'
W o6 '{"op":"talk","to":["Doorman-T"],"mode":"demand","text":"[Alpha, in world G] and npm? SECRET-A2"}'
W o7 '{"op":"talk","to":["Doorman-T"],"mode":"demand","text":"[Beta, in world G] github? SECRET-B"}'
chk "no Doorman inbox item has a history field" "! grep -l '\"history\"' $R/x/dinbox/*.json >/dev/null 2>&1"
chk "each question item holds only its own message (A2 has no SECRET-A, B has no SECRET-A)" "python3 -c \"
import json,glob,sys
ms=[json.load(open(f)) for f in sorted(glob.glob('$R/x/dinbox/*.json'))]; ms=[m for m in ms if m.get('type')=='message']
a2=[m for m in ms if 'SECRET-A2' in m['text']]; b=[m for m in ms if 'SECRET-B' in m['text']]
sys.exit(0 if a2 and b and 'SECRET-A\\\\n' not in a2[0]['text'] and 'SECRET-A ' not in a2[0]['text'] and 'SECRET-A' not in b[0]['text'] else 1)\""
chk "no doorman-history.json is written" "[ ! -e $P/doorman-history.json ]"
echo "== a draft names Beta, but it answers Alpha's message (about): the outcome goes to Alpha"
RQ=$(python3 -c "
import json,glob
for f in sorted(glob.glob('$R/x/dinbox/*.json')):
  d=json.load(open(f))
  if d.get('type')=='message' and 'SECRET-A2' in d.get('text',''): print(d['request_id'])")
D o8 '{"op":"draft","for":"Beta","about":"'$RQ'","why":"x","action":"allow foo.org"}'; ID8=$(ls $P/pending/ | sed -n 's/\.json$//p' | head -1); printf 'terminal\n' > $P/decisions/$ID8.deny; sleep 4
chk "the outcome of $ID8 went to Alpha (the asker of $RQ), not to Beta" "G | grep -q 'Alpha: \[Outside\] Angus denied the request drafted for you ($ID8)' && ! G | grep -q 'Beta: \[Outside\] Angus denied the request drafted for you ($ID8)'"
echo "outcomes: $FAILS failed"
E2E_RC=$(( FAILS > 0 ))
