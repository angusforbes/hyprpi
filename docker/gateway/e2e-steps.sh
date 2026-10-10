echo "== 1 open (approve)"; D 1-open '{"op":"request","type":"open_for_owner","for":"Alpha","params":{"what":"https://example.org/cube?trk=1","why":"see the result"}}'; res $R/x/dinbox 1-open; ID=$(pend | awk '$2=="open_for_owner"{print $1}'); echo "  held $ID"; decide $ID approve
echo "  opened: $(cat $R/x/opened 2>/dev/null)"; echo "  record: $(python3 -c "import json;d=json.load(open('$P/requests/$ID.json'));print(d['state'],'|',d['outcome']['summary'])")"
echo "  log: $(grep -h "\"op\":\"typed\"" $P/log.jsonl | tail -1 | cut -c1-200)"
echo "  G inbox:"; grep -h '"text"' $R/x/inbox/*.json | tail -2 | cut -c1-220
echo "  doorman note: $(grep -h '"typed"' $R/x/dinbox/*.json -l | wc -l)"
echo "  track: $(cd $H && XDG_STATE_HOME=$R/x/xstate node -e "import('./lib/held.mjs').then(m=>console.log(JSON.stringify(m.trackHeld('$ID'))))")"
echo "== 2 note (deny)"; D 2-note '{"op":"request","type":"note_to_owner","for":"Beta","params":{"text":"the cube render is done"}}'; ID=$(pend | awk '$2=="note_to_owner"{print $1}'); decide $ID deny
echo "  record: $(python3 -c "import json;d=json.load(open('$P/requests/$ID.json'));print(d['state'],'|',d['outcome']['summary'])")"; grep -h '"text"' $R/x/inbox/*.json | tail -2 | cut -c1-200
echo "== 3 forged/oversized"; D 3-bad '{"op":"request","type":"send_file","for":"Alpha","params":{"path":"/etc/passwd","why":"x"}}'; res $R/x/dinbox 3-bad
D 4-bad '{"op":"request","type":"note_to_owner","for":"Alpha","params":{"text":"'$(python3 -c "print('x'*1600)")'"}}'; res $R/x/dinbox 4-bad
D 5-bad '{"op":"request","type":"run_command","for":"Alpha","params":{"cmd":"rm -rf /","why":"x"}}'; res $R/x/dinbox 5-bad
W 6-bad '{"op":"request","type":"note_to_owner","params":{"text":"from the sandbox itself"}}'; res $R/x/inbox 6-bad
echo "== 4 send_file (approve)"; D 7-send '{"op":"request","type":"send_file","for":"Alpha","params":{"path":"'$R'/x/Work/proj/notes.md","why":"needs it"}}'; ID=$(pend | awk '$2=="send_file"{print $1}'); decide $ID approve; ls $R/x/inbox | grep file- ; echo "  record: $(python3 -c "import json;d=json.load(open('$P/requests/$ID.json'));print(d['state'],'|',d['outcome']['summary'])")"
echo "== 5 task change tells the asker"; D 8-task '{"op":"task_change","task":"Perovskite and tandem cells","why":"moved on","for":"Gamma"}'; ID=$(pend | awk '$3=="Gamma"{print $1}'); decide $ID approve; grep -h 'Gamma' $R/x/inbox/*.json | tail -1 | cut -c1-200
echo "== 6 agent-free refusals (HOSTAGENTS=$HA)"; D 9-draft '{"op":"draft","for":"Alpha","why":"x","action":"install foo on the laptop"}'; res $R/x/dinbox 9-draft
W 10-talk '{"op":"talk","to":["Thoughts-B"],"text":"hi"}'; res $R/x/inbox 10-talk
echo "== 7 allow_host (approve, stub sbx)"; D 11-allow '{"op":"request","type":"allow_host","for":"Alpha","params":{"host":"unpkg.com","why":"three.js"}}'; ID=$(pend | awk '$2=="allow_host"{print $1}'); decide $ID approve; echo "  sbx: $(cat $R/x/sbx-calls)"; echo "  record: $(python3 -c "import json;d=json.load(open('$P/requests/$ID.json'));print(d['state'],'|',d['outcome']['summary'])")"
echo "== 8 share_project (approve)"; D 12-share '{"op":"request","type":"share_project","for":"Alpha","params":{"project":"proj","mode":"ro","why":"read it"}}'; ID=$(pend | awk '$2=="share_project"{print $1}'); decide $ID approve; echo "  record: $(python3 -c "import json;d=json.load(open('$P/requests/$ID.json'));print(d['state'],'|',d['outcome']['summary'])")"
