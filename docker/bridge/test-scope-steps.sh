# J428 steps for docker/gateway/e2e.sh: a host job's folders = the sandbox's shares (same rights) + what the host finds beyond them
# after Angus's 1. Run:  HOSTAGENTS='"bridge"' E2E_STEPS=docker/bridge/test-scope-steps.sh bash docker/gateway/e2e.sh
# Isolated (test daemon and relay, temp state); scratch folders under ~/Work/j428-e2e-* (removed at the end); a stub agent for the scoping run.
E2E_RC=0; fail() { echo "FAIL: $*"; E2E_RC=1; }; ok() { echo "ok $*"; }
BR="$H/docker/bridge/doorman-bridge"; export DOORMAN_STATE=$P
X=$HOME/Work/j428-e2e-$$; mkdir -p $X/rw/sub $X/ro $X/extra; echo s > $X/rw/sub/.keep
( cd $X/rw && git init -q && echo "secret/" > .gitignore && mkdir -p secret && echo k > secret/k ) # a gitignored folder: hidden from the sandbox and the job
cat > $XDG_CONFIG_HOME/hyprpi/worlds/world-t.json <<J
{ "sandbox": "world-t", "task": "test", "gateway": { "mode": "open" }, "projects": [], "roles": {}, "shares": [ { "path": "$X/rw", "mode": "rw" }, { "path": "$X/ro", "mode": "ro" } ] }
J
T=$($BR --json register E2E-Host --harness test | python3 -c "import json,sys;print(json.load(sys.stdin)['agent_token'])"); sleep 2
held() { for f in $P/pending/*.json; do [ -f $f ] && python3 -c "import json;d=json.load(open('$f'));print(d['id'],'|',d['text'].replace(chr(10),' / ')) if d.get('draft') or d.get('hostJobScope') else None"; done; }
job() { python3 -c "import json;d=json.load(open('$P/requests/$1.json'));a=d['approved'];print(d['state'],'|',a['folders'],'| ro',a.get('read_only'),'| hidden',a.get('hidden'),'|',a['tools'])"; }
argv() { node -e "import('$H/docker/bridge/runner.mjs').then(({plan})=>{const j=JSON.parse(require('fs').readFileSync('$P/requests/$1.json','utf8'));console.log(plan(j,{mcpConfig:'/tmp/m.json'}).argv.join(' '))})"; }
echo "== 1 refused at draft time (W1)"
D r1 '{"op":"draft","for":"Alpha","why":"x","action":"x","folders":[{"path":"'$HOME'","access":"read"}]}'
r=$(res $R/x/dinbox r1); case "$r" in *"never the home folder itself"*) ok "home root refused";; *) fail "r1: $r";; esac
D r2 '{"op":"draft","for":"Alpha","why":"x","action":"x","folders":[{"path":"~/.ssh","access":"read"}]}'
r=$(res $R/x/dinbox r2); case "$r" in *"hidden"*) ok "~/.ssh refused";; *) fail "r2: $r";; esac
D r3 '{"op":"draft","for":"Alpha","why":"x","action":"x","folders":[{"path":"'$X'/ro","access":"write"}]}'
r=$(res $R/x/dinbox r3); case "$r" in *"read-only (protected)"*) ok "a read-only share for writing refused";; *) fail "r3: $r";; esac
D r4 '{"op":"draft","for":"Alpha","why":"x","action":"x","tools":["default"]}'
r=$(res $R/x/dinbox r4); case "$r" in *"isn't allowed"*) ok "an unknown tool refused";; *) fail "r4: $r";; esac
[ -z "$(held)" ] && ok "nothing held for the refused drafts" || fail "held: $(held)"
echo "== 1b a folder named in the draft and recreated before the 1: not approved (J428Check)"
mkdir -p $X/named
D n1 '{"op":"draft","for":"Alpha","why":"x","action":"read named","folders":[{"path":"'$X'/named","access":"read"}]}'
hn=$(held); case "$hn" in *"BEYOND T's SHARES: $X/named (read only)"*) ok "a named folder beyond the shares is shown prominently";; *) fail "held: $hn";; esac
N1=$(echo "$hn" | awk '{print $1}' | head -1); mv $X/named /tmp/j428-named-$$ && mkdir $X/named; decide $N1 approve
[ ! -f $P/requests/$N1.json ] && ok "recreated before the 1: no job made (denied)" || fail "job made: $(job $N1)"
rm -rf /tmp/j428-named-$$; for f in $P/pending/*.json; do :; done
echo "== 2 a draft naming no folders: exactly the sandbox's shares and rights (W5)"
D g1 '{"op":"draft","for":"Alpha","why":"summary","action":"write SUMMARY.md in '$X'/rw from '$X'/ro"}'
h=$(held); echo "  held: ${h:0:420}"
case "$h" in *"Folders: T's shares (2 folders, 1 writable"*"Tools: Read, Glob, Grep, Write, Edit"*) ok "held item: the shares, briefly";; *) fail "held: $h";; esac
case "$h" in *BEYOND*) fail "BEYOND shown for a shares-only job";; *) ok "nothing beyond";; esac
J1=$(echo "$h" | awk '{print $1}' | head -1); decide $J1 approve
j=$(job $J1); echo "  job: $j"; case "$j" in "waiting | ['$X/rw', '$X/ro'] | ro ['$X/ro'] | hidden ['$X/rw/secret']"*) ok "the job: the shares, the read-only one marked, the hidden path kept hidden";; *) fail "job: $j";; esac
a=$(argv $J1); echo "  runner: $a"
case "$a" in *"--disallowedTools Write(/$X/ro/**) Edit(/$X/ro/**)"*"Read(/$X/rw/secret)"*"--add-dir $X/rw --add-dir $X/ro"*) ok "runner: --add-dir the shares, writes denied in the ro one, the hidden path unreadable";; *) fail "argv";; esac
echo "== 3 something beyond the shares: described, scoped read-only by the host, Angus says 1 (W6)"
D b1 '{"op":"draft","for":"Alpha","why":"needs the extra notes","action":"copy the notes into '$X'/rw","needs_beyond":"the extra notes folder next to the rw share"}'
h=$(held | grep -v $J1); case "$h" in *"BEYOND T's shares (the sandbox's description): the extra notes folder"*"asks you 1 / 2"*) ok "held draft: the description shown prominently";; *) fail "held: $h";; esac
J2=$(echo "$h" | awk '{print $1}' | head -1); decide $J2 approve
st=$(python3 -c "import json;print(json.load(open('$P/requests/$J2.json'))['state'])"); [ "$st" = scoping ] && ok "the approved job goes scoping" || fail "state $st"
STUB=$R/x/stub-agent.sh; printf '#!/bin/sh\necho "$@" > %s/stub-argv.txt\ncat > %s/stub-prompt.txt\necho "I looked."\necho %s\n' $R/x $R/x "'{\"folders\":[{\"path\":\"$X/extra\",\"access\":\"read\"},{\"path\":\"$HOME/.ssh\",\"access\":\"read\"}],\"why\":\"found by name\"}'" > $STUB; chmod +x $STUB
s=$(DOORMAN_RUNNER_CMD="[\"$STUB\"]" $BR --json scope-job $J2); echo "  scope-job: ${s:0:300}"
sa=$(cat $R/x/stub-argv.txt); case "$sa" in *"--tools Glob --allowedTools Glob --disallowedTools Read(/$HOME/.*)"*"--add-dir $HOME"*) ok "scoping run: Glob only (names), dot folders denied";; *) fail "scope argv: $sa";; esac
case "$s" in *"proposed to the owner: $X/extra (read)"*) ok "proposal: $X/extra (read); ~/.ssh dropped by the rules";; *) fail "scope: $s";; esac
sleep 3; hp=$(held | grep "needs, beyond"); echo "  proposal held: ${hp:0:300}"
case "$hp" in *"⚠ $X/extra (read only)"*"1 approves these folders for this job only; 2 declines"*) ok "the proposal is held for 1 / 2";; *) fail "proposal: $hp";; esac
P2=$(echo "$hp" | awk '{print $1}'); decide $P2 approve
j=$(job $J2); echo "  job: $j"; case "$j" in "waiting | ['$X/rw', '$X/ro', '$X/extra'] | ro ['$X/ro', '$X/extra']"*) ok "after 1: waiting, with $X/extra read-only added";; *) fail "job: $j";; esac
case "$(argv $J2)" in *"--add-dir $X/extra"*"Write(/$X/extra/**)"*|*"Write(/$X/extra/**)"*"--add-dir $X/extra"*) ok "runner: --add-dir $X/extra, writes denied there";; *) fail "argv2: $(argv $J2)";; esac
echo "== 4 a 2 ends it"
D b2 '{"op":"draft","for":"Alpha","why":"x","action":"y","needs_beyond":"the extra folder"}'
J3=$(held | grep -v "$J1\|$J2\|needs, beyond" | awk '{print $1}' | head -1); decide $J3 approve
DOORMAN_RUNNER_CMD="[\"$STUB\"]" $BR --json scope-job $J3 >/dev/null; sleep 3
P3=$(held | grep "needs, beyond" | grep "$J3" | awk '{print $1}'); decide $P3 deny
st=$(python3 -c "import json;print(json.load(open('$P/requests/$J3.json'))['state'])"); [ "$st" = declined ] && ok "after 2: declined" || fail "state $st"
o=$(grep -rh "declined the extra folders" $R/x/inbox 2>/dev/null | head -1); [ -n "$o" ] && ok "the asker hears it was declined" || fail "no outcome to the asker"
echo "== 4b a folder swapped after the proposal: Angus's 1 doesn't approve the new one (J428Review)"
mkdir -p $X/extra2; printf '#!/bin/sh\ncat >/dev/null\necho %s\n' "'{\"folders\":[{\"path\":\"$X/extra2\",\"access\":\"read\"}],\"why\":\"x\"}'" > $R/x/stub2.sh; chmod +x $R/x/stub2.sh
D b3 '{"op":"draft","for":"Alpha","why":"x","action":"z","needs_beyond":"extra2"}'
J4=$(held | grep -v "$J1\|$J2\|$J3\|needs, beyond" | awk '{print $1}' | head -1); decide $J4 approve
DOORMAN_RUNNER_CMD="[\"$R/x/stub2.sh\"]" $BR --json scope-job $J4 >/dev/null; sleep 3
P4=$(held | grep "needs, beyond" | grep "$J4" | awk '{print $1}')
mv $X/extra2 $X/extra2.old && mkdir -p $X/other && ln -s $X/other $X/extra2.tmp && mkdir $X/extra2 && rmdir $X/extra2 && mv $X/extra2.old /tmp/j428-swapped-$$ && mkdir $X/extra2
decide $P4 approve
st=$(python3 -c "import json;print(json.load(open('$P/requests/$J4.json'))['state'])"); [ "$st" = declined ] && ok "a recreated folder (new inode) at the proposed path: the 1 became a decline" || fail "state $st: $(job $J4)"
rm -rf /tmp/j428-swapped-$$
echo "== 4c a write child inside a read-only parent in the same proposal: refused (J428Check)"
mkdir -p $X/par/child; printf '#!/bin/sh\ncat >/dev/null\necho %s\n' "'{\"folders\":[{\"path\":\"$X/par\",\"access\":\"read\"},{\"path\":\"$X/par/child\",\"access\":\"write\"}],\"why\":\"x\"}'" > $R/x/stub3.sh; chmod +x $R/x/stub3.sh
D b4 '{"op":"draft","for":"Alpha","why":"x","action":"w","needs_beyond":"par"}'
J5=$(held | grep -v "$J1\|$J2\|$J3\|$J4\|needs, beyond" | awk '{print $1}' | head -1); decide $J5 approve
s5=$(DOORMAN_RUNNER_CMD="[\"$R/x/stub3.sh\"]" $BR --json scope-job $J5); case "$s5" in *"proposed to the owner: $X/par (read)\""*|*"proposed to the owner: $X/par (read)"*) case "$s5" in *"par/child (write)"*) fail "child proposed: $s5";; *) ok "only the read-only parent is proposed; the write child refused";; esac;; *) fail "s5: $s5";; esac
echo "== 5 an answer can't widen; needs_wider goes to scoping (W2)"
CT=$($BR --json claim $J1 --agent-token $T | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
$BR --json ask $J1 --token $CT "may I also write in $X/extra?" >/dev/null; sleep 4
Q=$(python3 -c "import json;print(json.load(open('$P/requests/$J1.json'))['questions'][0]['held_id'])"); echo "  question held as $Q"
printf 'doorman window\nnote:%s' "$(printf 'yes, use it' | base64 -w0)" > $P/decisions/.$Q.tmp; mv $P/decisions/.$Q.tmp $P/decisions/$Q.approve; sleep 4
j=$(job $J1); case "$j" in *"| ['$X/rw', '$X/ro'] |"*) ok "the owner's answer didn't widen the job ($(echo $j | cut -d'|' -f1))";; *) fail "widened: $j";; esac
r=$($BR --json report $J1 needs_wider --token $CT --summary "it also needs write access to the extra folder"); case "$r" in *'"ok": true'*) ok "report needs_wider";; *) fail "report: $r";; esac
st=$(python3 -c "import json;d=json.load(open('$P/requests/$J1.json'));print(d['state'],d['widenings'])"); [ "$st" = "scoping 1" ] && ok "needs_wider → scoping (the host looks, then asks 1 / 2)" || fail "state $st"
rm -rf $X
