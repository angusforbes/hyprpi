#!/usr/bin/env bash
# J538 proof (Angus: a click on the current world in the top bar should "move the current Thoughts to the workspace and focus on it,
# if it's not already in there. If it is, do nothing"): mockups/panels L --only 3 --if-absent, as the hyprwrlds bar runs it, against
# a FAKE hyprctl (window list from a JSON file, every dispatch logged), a fake kitty and an isolated daemon: no real window moves.
#   bash test/bar-thoughts-click.sh   (exit 0 = pass)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; fails=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
mkdir -p "$T/bin" "$T/state" "$T/run"
cat > "$T/bin/hyprctl" <<EOF
#!/bin/bash
# fake: -j VERB answers from $T/VERB.json; anything else is logged
if [[ "\$1" == -j ]]; then v="\$2"; [[ -f "$T/\$v.json" ]] && cat "$T/\$v.json" || echo '[]'; exit 0; fi
echo "\$*" >> "$T/dispatch.log"
# a remote panel opened through exec_cmd "maps" on the workspace it was opened on (as kitty would)
if [[ "\$*" == *"--class=hyprpi.i-panel --title hyprpi-search"* ]]; then ws=\$(sed -n 's/.*workspace = "\([0-9]*\) silent".*/\1/p' <<< "\$*"); jq --argjson ws "\$ws" '. + [{"address":"0xnew1","class":"hyprpi.i-panel","title":"hyprpi-search I","workspace":{"id":\$ws,"name":(\$ws|tostring)},"pid":1,"floating":false,"fullscreen":0,"at":[0,0],"size":[100,100]}]' "$T/clients.json" > "$T/c.tmp" && mv "$T/c.tmp" "$T/clients.json"; fi
echo ok
EOF
printf '#!/bin/sh\necho "kitty $*" >> %s/dispatch.log\n' "$T" > "$T/bin/kitty"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/pgrep" # fake: no running panel loop (the real laptop may have one for world I)
chmod +x "$T"/bin/*
export PATH="$T/bin:$PATH" HYPRPI_SOCKET="$T/run/d.sock" HYPRPI_STATE="$T/state" XDG_RUNTIME_DIR="$T/run" HYPRPI_ALLOW_HYPR=1 HYPRPI_NO_ENSURE=1 HYPRPI_UPKEEP_MS=3600000 HYPRLAND_INSTANCE_SIGNATURE=j538-fake
unset HYPRPI_AGENT_ID HYPRPI_WORKSPACE
node "$ROOT/bin/hyprpi" daemon > "$T/d.log" 2>&1 & D=$!
trap 'kill $D 2>/dev/null; wait $D 2>/dev/null; [[ $fails -eq 0 ]] && rm -rf "$T"' EXIT
for _ in $(seq 50); do [[ -S "$T/run/d.sock" ]] && break; sleep 0.2; done
echo '[{"id":1,"name":"eDP-1","focused":true,"x":0,"y":0,"width":2880,"height":1800,"scale":1.6,"reserved":[0,35,0,0]}]' > "$T/monitors.json"
win() { echo "{\"address\":\"$1\",\"class\":\"$2\",\"title\":\"$3\",\"workspace\":{\"id\":$4,\"name\":\"$4\"},\"pid\":1,\"floating\":false,\"fullscreen\":0,\"at\":[0,0],\"size\":[100,100]}"; }
setup() { # $1 = active ws, rest = window JSON objects
  echo "{\"id\":$1,\"name\":\"$1\"}" > "$T/activeworkspace.json"; shift
  (IFS=,; echo "[$*]") > "$T/clients.json"; : > "$T/dispatch.log"
}
click() { timeout 20 "$ROOT/mockups/panels" "$1" --only 3 --if-absent >/dev/null 2>&1; true; }
moved() { grep -q "movetoworkspace\|move_to_workspace\|window.move.*workspace\|movetoworkspacesilent" "$T/dispatch.log" || grep -qE "hl\.dsp\.window\.move\(\{ *workspace" "$T/dispatch.log"; }
focused() { grep -qE "focus.*$1|focuswindow.*$1" "$T/dispatch.log"; }

# A (a local world): Thoughts on another workspace → moved here and focused
setup 2 "$(win 0xaaa1 hyprpi.mockup 'hyprpi-search A' 5)" "$(win 0xbbb1 kitty 'π - Atlas' 2)"
click A
ok "A: Thoughts on ws 5, I'm on ws 2 → it's moved to ws 2" "grep -q '0xaaa1' $T/dispatch.log && grep -qE '0xaaa1.*\"?2\"?|\"2\".*0xaaa1|workspace.*2' $T/dispatch.log"
ok "A: … and focused" "focused 0xaaa1"
# A: already here → nothing at all
setup 2 "$(win 0xaaa1 hyprpi.mockup 'hyprpi-search A' 2)" "$(win 0xbbb1 kitty 'π - Atlas' 2)"
click A
ok "A: Thoughts already on ws 2 → no dispatch at all (no move, no focus)" "[[ ! -s $T/dispatch.log ]]"
# A: not open anywhere → opened (kitty search-tui A), here
setup 2 "$(win 0xbbb1 kitty 'π - Atlas' 2)"
click A
ok "A: no Thoughts window → it's opened (search-tui A)" "grep -q 'kitty .*search-tui.mjs A' $T/dispatch.log"
# a copy elsewhere AND one here → nothing (one here counts)
setup 2 "$(win 0xaaa1 hyprpi.mockup 'hyprpi-search A' 5)" "$(win 0xaaa2 hyprpi.mockup 'hyprpi-search A' 2)"
click A
ok "A: one copy here (another elsewhere) → nothing" "[[ ! -s $T/dispatch.log ]]"

# I (a remote world): its remote Thoughts panel window. J575: against a FIXTURE binding (a temp XDG_CONFIG_HOME with remote/i.json),
# never Angus's live ~/.config/hyprpi/remote/i.json, in both panel modes: "pty" (J480: panel-loop.sh over ssh -t) and "link"
# (J555: panel-link.sh, the local panel through the world's link), the live binding's mode since J555.
mkdir -p "$T/cfg/hyprpi/remote"
clickI() { XDG_CONFIG_HOME="$T/cfg" timeout 20 "$ROOT/mockups/panels" I --only 3 --if-absent >/dev/null 2>&1; true; }
for mode in pty link; do
  printf '{"ssh":["ssh","nohost-j575.invalid"],"label":"Fixture I","prefix":"fx-","panels":"%s"}\n' "$mode" > "$T/cfg/hyprpi/remote/i.json"
  setup 82 "$(win 0xccc1 hyprpi.i-panel 'hyprpi-search I' 81)"
  clickI
  ok "I (remote, $mode): its Thoughts panel on ws 81, I'm on ws 82 → moved to 82" "grep -q '0xccc1' $T/dispatch.log && grep -q '82' $T/dispatch.log"
  ok "I (remote, $mode): … and focused" "focused 0xccc1"
  setup 81 "$(win 0xccc1 hyprpi.i-panel 'hyprpi-search I' 81)"
  clickI
  ok "I (remote, $mode): already on ws 81 → nothing" "[[ ! -s $T/dispatch.log ]]"
  setup 82
  clickI
  ok "I (remote, $mode): not open → … and focused once it maps" "focused 0xnew1"
  want=$([[ $mode == link ]] && echo 'panel-link.sh I search' || echo 'panel-loop.sh I search')
  ok "I (remote, $mode): not open → world I's remote search panel is opened here ($want)" "grep -qE 'hyprpi-search[\\]? I' $T/dispatch.log && grep -q '$want' $T/dispatch.log"
done
echo "--- dispatch log of the last case"; cat "$T/dispatch.log" | cut -c1-200
[[ $fails -eq 0 ]] && echo "all passed" || echo "$fails FAILED (state $T)"
exit $fails
