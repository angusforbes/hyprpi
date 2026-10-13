#!/usr/bin/env bash
# J525: brev/tailscale/ts-setup + ts-join.sh with a fake ssh (runs the remote command locally in a scratch HOME) and fake
# tailscale / sudo / systemctl. Never touches the real tailnet; the fake key never appears in any output.
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0; ok() { if eval "$2"; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
mkdir -p "$T/bin" "$T/box" "$T/lap/.config/hyprpi-secrets"; chmod 700 "$T/lap/.config/hyprpi-secrets"
# the "box": HOME=$T/box; tailscale state in $T/ts (Running or not), calls logged
cat > "$T/bin/fakessh" <<EOF
#!/usr/bin/env bash
shift  # the host
HOME="$T/box" PATH="$T/bin:\$PATH" bash -c "\$*"
EOF
cat > "$T/bin/tailscale" <<EOF
#!/usr/bin/env bash
echo "tailscale \$*" >> "$T/calls"
case "\$1" in
  status) [[ -f "$T/ts" ]] && printf '{\n\t"BackendState" :\t"Running",\n "Self": {"DNSName": "%s.tail1c2031.ts.net."}}\n' "\$(cat "$T/ts")" || echo '{"BackendState": "NeedsLogin"}';;
  up) for a in "\$@"; do case "\$a" in --auth-key=file:*) f="\${a#--auth-key=file:}"; cp "\$f" "$T/key-seen"; stat -c %a "\$f" > "$T/key-mode";; --hostname=*) echo "\${a#--hostname=}" > "$T/ts";; esac; done
      [[ "\$(cat "$T/key-seen")" == tskey-auth-FAKE123 ]] || { echo "invalid key tskey-auth-WRONG"; rm -f "$T/ts"; exit 1; };;
  set) [[ -f "$T/set-fails" ]] && exit 1; echo "set \$*" >> "$T/calls";;
esac
EOF
printf '#!/usr/bin/env bash\n"$@"\n' > "$T/bin/sudo"; printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/systemctl"
chmod +x "$T/bin/"*
export XDG_CONFIG_HOME="$T/lap/.config" HOME="$T/lap"
KF="$T/lap/.config/hyprpi-secrets/tailscale-authkey"
run() { PATH="$T/bin:$PATH" "$R/brev/tailscale/ts-setup" "$1" i "$T/bin/fakessh" ubuntu@hub 2>&1; }
echo '{"ssh":["ssh","hub"]}' > "$T/off.json"; o=$(run "$T/off.json")
ok "off by default: nothing sent, no output" '[[ -z "$o" && ! -f "$T/calls" ]]'
echo '{"ssh":["ssh","hub"],"tailscale":true}' > "$T/on.json"; o=$(run "$T/on.json")
ok "no key file yet: says so, exit 0, nothing joined" '[[ "$o" == *"no Tailscale auth key"* && ! -f "$T/ts" ]]'
printf 'tskey-auth-FAKE123\n' > "$KF"; chmod 644 "$KF"; o=$(run "$T/on.json")
ok "a key file readable by others is refused" '[[ "$o" == *"600 in a 700 folder"* && ! -f "$T/ts" ]]'
chmod 600 "$KF"; o=$(run "$T/on.json"); rc=$?
ok "joins: tailnet name printed, hostname from the ssh target" '[[ $rc == 0 && "$o" == *"tailnet hub.tail1c2031.ts.net"* ]]'
ok "Tailscale SSH on by default" 'grep -q -- "--ssh" "$T/calls"'
ok "the key reached tailscale up through a 600 file, then was removed" '[[ "$(cat "$T/key-seen")" == tskey-auth-FAKE123 && "$(cat "$T/key-mode")" == 600 ]] && ! grep -rqs FAKE123 "$T/box"'
ok "the key is never on a command line or in the output" '! grep -q FAKE123 "$T/calls" && [[ "$o" != *FAKE123* ]]'
: > "$T/calls"; o=$(run "$T/on.json")
ok "second run: already in the tailnet, no key sent, no up" '[[ "$o" == *"tailnet hub"* ]] && ! grep -q " up" "$T/calls"'
rm -f "$T/ts"; echo '{"ssh":["ssh","x"],"tailscale":{"hostname":"home-box","ssh":false}}' > "$T/obj.json"; : > "$T/calls"; o=$(run "$T/obj.json")
ok "object form: own hostname, ssh false = no --ssh" '[[ "$o" == *"tailnet home-box"* ]] && ! grep -q -- "--ssh" "$T/calls"'
rm -f "$T/ts"; printf 'tskey-auth-WRONG\n' > "$KF"; o=$(run "$T/on.json"); rc=$?
ok "a refused key: clear failure, nonzero, key text masked" '[[ $rc != 0 && "$o" == *"up failed"* && "$o" != *tskey-auth-WRONG* ]]'
echo '{"ssh":["ssh","x"],"tailscale":{"hostname":"Bad Name"}}' > "$T/bad.json"; o=$(run "$T/bad.json"); rc=$?
ok "a bad hostname is refused" '[[ $rc == 2 && "$o" == *"bad tailscale hostname"* ]]'
rm -f "$T/ts"; printf 'tskey-auth-FAKE123\n' > "$KF"; run "$T/on.json" >/dev/null; touch "$T/set-fails"; o=$(run "$T/on.json"); rc=$?; rm -f "$T/set-fails"
ok "already joined but Tailscale SSH can't be turned on: a clear failure" '[[ $rc != 0 && "$o" == *"turning on Tailscale SSH failed"* ]]'
: > "$T/calls"; o=$(run "$T/obj.json"); ok "ssh false on a joined machine turns Tailscale SSH off" 'grep -q -- "--ssh=false" "$T/calls"'
ok "whitespace-formatted status JSON still counts as Running (no key sent again)" '! grep -q " up" "$T/calls"'
chmod 666 "$T/on.json"; o=$(run "$T/on.json"); rc=$?; chmod 644 "$T/on.json"
ok "a binding writable by others: the key is not sent" '[[ $rc == 2 && "$o" == *"writable by others"* ]]'
mkdir -m777 "$T/open"; cp "$T/on.json" "$T/safe.json"; chmod 644 "$T/safe.json"; ln -s "$T/safe.json" "$T/open/link.json"
o=$(run "$T/open/link.json"); rc=$?
ok "a binding reached through a link in a folder others can write: refused" '[[ $rc == 2 && "$o" == *"writable by others"* ]]'
# the whole world command: an unsafe binding with "tailscale" must stop before its ssh runs at all
printf '#!/usr/bin/env bash\ntouch "%s/evil-ran"\n' "$T" > "$T/bin/evilssh"; chmod +x "$T/bin/evilssh"
printf '{"ssh":["%s/bin/evilssh","x"],"tailscale":true}' "$T" > "$T/evil.json"; chmod 666 "$T/evil.json"
o=$(HYPRPI_REMOTE_CONF="$T/evil.json" "$R/omnistation/world" I setup 2>&1); rc=$?
ok "world setup with an unsafe tailscale binding runs none of its commands" '[[ $rc == 2 && ! -e "$T/evil-ran" && "$o" == *"writable by others"* ]]'
# a link owned by someone else (a stat stub says so for that one path): refused
ln -s "$T/safe.json" "$T/foreign-link.json"
cat > "$T/bin/stat" <<EOF2
#!/usr/bin/env bash
if [[ "\$*" == *"%U"* && "\${@: -1}" == "$T/foreign-link.json" ]]; then echo nobody; else exec /usr/bin/stat "\$@"; fi
EOF2
chmod +x "$T/bin/stat"; o=$(PATH="$T/bin:$PATH" "$R/brev/tailscale/ts-setup" --check "$T/foreign-link.json" 2>&1); rc=$?; rm -f "$T/bin/stat"
ok "a binding link owned by someone else: refused" '[[ $rc == 2 ]]'
echo "$pass passed, $fail failed"; exit $(( fail > 0 ))
