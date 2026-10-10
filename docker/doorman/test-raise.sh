#!/usr/bin/env bash
# bash docker/doorman/test-raise.sh  (J427): a toast's Review takes Angus TO the Doorman window: his workspace switches to the window's
# workspace and it is focused; the window never moves while it is inside world G's range. Fully stubbed: a fake hyprctl records dispatches
# (no real window, workspace or focus is touched); throwaway config under a temp XDG_CONFIG_HOME.
set -uo pipefail
H="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/cfg/hyprpi/worlds"
echo '{"sandboxes":[{"name":"doorman-t","doorman_for":"world-t","visibility":"developer","visibility_workspace":68}]}' > "$T/cfg/hyprpi/sbx-relay.json"
echo '{"sandbox":"world-t","workspaces":[61,69]}' > "$T/cfg/hyprpi/worlds/world-t.json"
cat > "$T/bin/hyprctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-j" && "$2" == "clients" ]]; then cat "$FAKE_CLIENTS"; exit 0; fi
if [[ "$1" == "-j" && "$2" == "activeworkspace" ]]; then echo '{"id":11}'; exit 0; fi
if [[ "$1" == "dispatch" ]]; then echo "$2" >> "$FAKE_LOG"; exit 0; fi
EOF
chmod +x "$T/bin/hyprctl"
export PATH="$T/bin:$PATH" XDG_CONFIG_HOME="$T/cfg" FAKE_LOG="$T/log" FAKE_CLIENTS="$T/clients.json"
FAILS=0; chk() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi; }
run() { : > "$T/log"; echo "[{\"address\":\"0xabc\",\"class\":\"hyprpi-doorman-doorman-t\",\"workspace\":{\"id\":$1}},{\"address\":\"0xa1\",\"class\":\"hyprpi.g-agent\",\"title\":\"π - Alpha - world-g\",\"workspace\":{\"id\":63}}]" > "$T/clients.json"; bash "$H/docker/doorman/doorman.sh" raise doorman-t Alpha >/dev/null 2>&1; RC=$?; }
order() { [[ "$(grep -o 'window.move\|focus({ workspace\|focus({ window' "$T/log" | tr '\n' ,)" == "$1" ]]; }
run 61
chk "on 61 (inside G): Angus is taken to 61, the window is focused" "grep -q 'focus({ workspace = \"61\" })' $T/log && grep -q 'focus({ window = \"address:0xabc\" })' $T/log"
chk "… and the window doesn't move (not even to the asker's workspace 63)" "! grep -q 'window.move' $T/log"
run 68
chk "on its home 68: Angus is taken to 68, no move" "grep -q 'focus({ workspace = \"68\" })' $T/log && ! grep -q 'window.move' $T/log"
run 3
chk "found on Angus's own workspace 3 (outside G): it goes home to 68 first, then he is taken there" "grep -q 'workspace = \"68\", follow = false' $T/log && grep -q 'focus({ workspace = \"68\" })' $T/log"
run -98
chk "on a special workspace: home to 68, then there" "grep -q 'workspace = \"68\", follow = false' $T/log && grep -q 'focus({ workspace = \"68\" })' $T/log"
chk "… in the order: move home, switch workspace, focus the window; exit 0" "order 'window.move,focus({ workspace,focus({ window,' && [[ \$RC == 0 ]]"
run 61; chk "inside G: switch, then focus, nothing else; exit 0" "order 'focus({ workspace,focus({ window,' && [[ \$RC == 0 ]]"
cp "$T/cfg/hyprpi/worlds/world-t.json" "$T/w.bak"; echo '{"sandbox":"world-t"}' > "$T/cfg/hyprpi/worlds/world-t.json"; run 61
chk "a world file with no workspace range: only home counts as G, so a window on 61 goes home to 68; exit 0" "order 'window.move,focus({ workspace,focus({ window,' && grep -q 'focus({ workspace = \"68\" })' $T/log && [[ \$RC == 0 ]]"
echo '{not json' > "$T/cfg/hyprpi/worlds/world-t.json"; run 61
chk "an unreadable world file: the mode can't be read (safe: no window), nothing dispatched, exit 0" "[[ ! -s $T/log && \$RC == 0 ]]"
mv "$T/w.bak" "$T/cfg/hyprpi/worlds/world-t.json"
echo '[{"address":"0xabc;os.execute(1)","class":"hyprpi-doorman-doorman-t","workspace":{"id":61}}]' > "$T/clients.json"; : > "$T/log"; bash "$H/docker/doorman/doorman.sh" raise doorman-t >/dev/null 2>&1; RC=$?
chk "a malformed address: nothing dispatched, exit 1" "[[ ! -s $T/log && \$RC == 1 ]]"
echo "raise: $FAILS failed"; exit $((FAILS > 0))
